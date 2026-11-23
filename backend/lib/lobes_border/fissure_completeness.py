"""Step 3: fissure completeness FI% = fraction of reference fissure-plane voxels with a detected visible-fissure
voxel (same fissure) within TOL mm. Computed for reference planes GT and TotalSegmentator."""
import sys, os, glob, json, numpy as np, pandas as pd, SimpleITK as sitk
from scipy import ndimage as ndi
B = "/storage/scratch/users/vd24z940/lobe_bench"; ds = sys.argv[1] if len(sys.argv) > 1 else "luna"; TOL = 3.0
REFS = ["GT"] + (sys.argv[2:] or ["TotalSegmentator"]); TAG = "" if REFS == ["GT", "TotalSegmentator"] else "_" + "_".join(REFS[1:])
NAMES = {1: "left_oblique", 2: "right_oblique", 3: "right_horizontal"}
rows = []
for gp in sorted(glob.glob(f"{B}/data/{ds}/gt/*.nii.gz")):
    cid = os.path.basename(gp)[:-7]; img = sitk.ReadImage(f"{B}/data/{ds}/images/{cid}_0000.nii.gz")
    sp = img.GetSpacing()[::-1]
    gfp = f"{B}/fissures/{ds}/GT/{cid}.nii.gz"; GTF = sitk.GetArrayFromImage(sitk.ReadImage(gfp)) if os.path.exists(gfp) else None
    for ref in REFS:
        pp, vp = f"{B}/fissures/{ds}/{ref}/{cid}.nii.gz", f"{B}/fissures/{ds}/visible_{ref}/{cid}.nii.gz"
        if not (os.path.exists(pp) and os.path.exists(vp)): continue
        P = sitk.GetArrayFromImage(sitk.ReadImage(pp)); V = sitk.GetArrayFromImage(sitk.ReadImage(vp))
        for k, n in NAMES.items():
            p = P == k
            if not p.any() or (GTF is not None and not (GTF == k).any()): continue  # skip fissures absent in GT (resection)
            v = V == k
            if v.any():
                bb = np.argwhere(p | v); lo = np.maximum(bb.min(0) - 6, 0); hi = bb.max(0) + 7; sl = tuple(slice(a, b) for a, b in zip(lo, hi))
                d = ndi.distance_transform_edt(~v[sl], sampling=sp); fi = (d[p[sl]] <= TOL).mean()
            else: fi = 0.0
            rows.append(dict(case=cid, ref=ref, fissure=n, FI=100 * fi, slice_mm=round(sp[0], 2)))
    print(cid, flush=True)
df = pd.DataFrame(rows); df["thin"] = df.slice_mm <= 1.25
df.to_csv(f"{B}/results/{ds}_completeness_per_case{TAG}.csv", index=False)
fp = f"{B}/data/{ds}/flagged_gt_errors.json"; bad = set(json.load(open(fp))) if os.path.exists(fp) else set()
c = df[~df.case.isin(bad)]
pd.set_option("display.width", 250)
summ = c.groupby(["thin", "fissure", "ref"]).FI.describe()[["count", "mean", "25%", "50%", "75%"]].round(1)
summ.to_csv(f"{B}/results/{ds}_completeness_summary{TAG}.csv"); print(summ)
w = c.pivot_table(index=["case", "fissure", "thin"], columns="ref", values="FI").reset_index()
e = pd.read_csv(f"{B}/results/{ds}_fissure_planes_per_case.csv"); ag, lk = [], []
for r in REFS[1:]:
    ww = w.dropna(subset=["GT", r])
    a = ww.groupby(["thin", "fissure"]).apply(lambda g: pd.Series(dict(n=len(g), pearson_r=np.corrcoef(g.GT, g[r])[0, 1],
        mean_abs_diff=(g.GT - g[r]).abs().mean(), mean_diff_ref_minus_GT=(g[r] - g.GT).mean()))).round(3); a["ref"] = r; ag.append(a)
    m = c[c.ref == "GT"].merge(e[e.method == r][["case", "fissure", "assd"]], on=["case", "fissure"])
    if len(m):
        l = m.groupby(["thin", "fissure"]).apply(lambda g: pd.Series(dict(n=len(g), spearman_FI_vs_referror=g.FI.rank().corr(g.assd.rank())))).round(3); l["ref"] = r; lk.append(l)
agree = pd.concat(ag); agree.to_csv(f"{B}/results/{ds}_completeness_agreement{TAG}.csv"); print("\nAgreement ref-plane vs GT-plane FI%\n", agree)
if lk: link = pd.concat(lk); link.to_csv(f"{B}/results/{ds}_completeness_vs_planeerror{TAG}.csv"); print("\nGT-plane FI% vs ref plane error (Spearman)\n", link)
