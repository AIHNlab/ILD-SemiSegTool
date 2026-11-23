"""Step 1: fissure planes from lobe masks; GT vs predicted plane distance per fissure.
Fissure surface = voxels of lobe group A 6-adjacent to group B, plus B adjacent to A (2-voxel thin).
Labels: 1=LUL 2=LLL 3=RUL 4=RML 5=RLL.  Saves fissure masks (1=LO, 2=RO, 3=RH) for GT and each method."""
import sys, os, glob, json, numpy as np, pandas as pd, SimpleITK as sitk
from scipy import ndimage as ndi
from multiprocessing import Pool
B = "/storage/scratch/users/vd24z940/lobe_bench"; ds = sys.argv[1] if len(sys.argv) > 1 else "luna"
FISS = {"left_oblique": ({1}, {2}), "right_oblique": ({3, 4}, {5}), "right_horizontal": ({3}, {4})}
METHODS = [m for m in sorted(os.listdir(f"{B}/preds/{ds}")) if not m.endswith("_raw") and m != "nnUNet_LUNA36"
           and not (m.startswith("nnUNet") and not m.endswith("_lcc"))]
ST = ndi.generate_binary_structure(3, 1)

def fissures(L):
    out = np.zeros(L.shape, np.uint8)
    for k, (fn, (a, b)) in enumerate(FISS.items(), 1):
        A, Bm = np.isin(L, list(a)), np.isin(L, list(b))
        out[(A & ndi.binary_dilation(Bm, ST)) | (Bm & ndi.binary_dilation(A, ST))] = k
    return out

def dist_metrics(g, p, sp, tol=2.0):
    if not g.any() or not p.any(): return dict(assd=np.nan, hd95=np.nan, gt_within_tol=np.nan, pred_within_tol=np.nan, nsd=np.nan)
    bb = np.argwhere(g | p); lo = np.maximum(bb.min(0) - 3, 0); hi = bb.max(0) + 4
    sl = tuple(slice(a, b) for a, b in zip(lo, hi)); g, p = g[sl], p[sl]
    dg = ndi.distance_transform_edt(~g, sampling=sp); dp = ndi.distance_transform_edt(~p, sampling=sp)
    d_g2p, d_p2g = dp[g], dg[p]
    return dict(assd=np.concatenate([d_g2p, d_p2g]).mean(), hd95=max(np.percentile(d_g2p, 95), np.percentile(d_p2g, 95)),
                gt_within_tol=(d_g2p <= tol).mean(), pred_within_tol=(d_p2g <= tol).mean(),
                nsd=((d_g2p <= tol).sum() + (d_p2g <= tol).sum()) / (len(d_g2p) + len(d_p2g)))

def run_case(gp):
    cid = os.path.basename(gp)[:-7]; gi = sitk.ReadImage(gp); sp = gi.GetSpacing()[::-1]
    def save(arr, name):
        os.makedirs(f"{B}/fissures/{ds}/{name}", exist_ok=True); o = sitk.GetImageFromArray(arr); o.CopyInformation(gi)
        sitk.WriteImage(o, f"{B}/fissures/{ds}/{name}/{cid}.nii.gz")
    FG = fissures(sitk.GetArrayFromImage(gi)); save(FG, "GT"); rows = []
    for m in METHODS:
        pp = f"{B}/preds/{ds}/{m}/{cid}.nii.gz"
        if not os.path.exists(pp): continue
        FP = fissures(sitk.GetArrayFromImage(sitk.ReadImage(pp))); save(FP, m)
        for k, fn in enumerate(FISS, 1):
            g, p = FG == k, FP == k
            rows.append(dict(case=cid, method=m, fissure=fn, area_gt_cm2=g.sum() * sp[1] * sp[2] / 100 / 2,
                             area_pred_cm2=p.sum() * sp[1] * sp[2] / 100 / 2, **dist_metrics(g, p, sp)))
    print(cid, flush=True); return rows

if __name__ == "__main__":
    gts = sorted(glob.glob(f"{B}/data/{ds}/gt/*.nii.gz"))
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4))) as pool: rows = sum(pool.map(run_case, gts), [])
    df = pd.DataFrame(rows); df.to_csv(f"{B}/results/{ds}_fissure_planes_per_case.csv", index=False)
    fp = f"{B}/data/{ds}/flagged_gt_errors.json"; bad = set(json.load(open(fp))) if os.path.exists(fp) else set()
    test = set(json.load(open(f"{B}/data/{ds}/split_seed42.json"))["test"])
    df = df[df.area_gt_cm2 > 0]  # fissure absent in GT (resected lobe) -> not evaluable
    pd.set_option("display.width", 250)
    for tag, sub in [("allcases_clean", df[~df.case.isin(bad)]), (f"test{len(test)}_clean", df[df.case.isin(test) & ~df.case.isin(bad)])]:
        s = sub.groupby(["fissure", "method"]).agg(n=("case", "nunique"), assd_mm=("assd", "mean"), hd95_mm=("hd95", "mean"),
              nsd_2mm=("nsd", "mean"), gt_within_2mm=("gt_within_tol", "mean"), missing=("assd", lambda x: x.isna().sum())).round(3)
        s.to_csv(f"{B}/results/{ds}_fissure_planes_{tag}.csv"); print(f"\n=== {tag} ===\n", s)
