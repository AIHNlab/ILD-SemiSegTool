"""Fissure 'zig-zag' / roughness metrics, v2 (robust). Same metric definitions as fissure_roughness.py (v1), plus:

1. Outlier rejection: the fissure is fitted as a smooth sheet (height field over its best-fit plane);
   detected voxels more than TOL mm off the sheet (false detections, parallel structures) are discarded and the
   sheet is refitted (coarse-to-fine: 20 mm, then 10 mm smoothing). Isolated islands < MIN_ISLAND_CM2 are dropped.
2. Fixed-size patches: 3D metrics are computed in W x W mm windows (stride W/2) that are >= MIN_COV covered by
   valid (interior) surface, then averaged -> removes the dependence on fissure size, edges and gaps.
   2D sagittal metrics use only the cleaned voxels and curve segments >= MIN_SEG_MM.
3. Quality flags per fissure/case: rejected_frac (share of detected voxels discarded in step 1) and
   noise_hu (robust high-pass noise estimate of lung parenchyma, HU).
Usage: fissure_roughness_v2.py <ds> <visible_dir_name> [cases...] -> results/<ds>_roughness_v2_<visible_dir_name>.csv"""
import sys, os, glob, numpy as np, pandas as pd, SimpleITK as sitk
from scipy import ndimage as ndi
from scipy.stats import binned_statistic_2d
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fissure_roughness import nconv, nconv_twice, curve_metrics, NAMES, SIG_F, SIG_L, GRID
import fissure_roughness as v1
B = "/storage/scratch/users/vd24z940/lobe_bench"
TOL_COMP, TOL_PT, MIN_ISLAND_CM2, MIN_AREA_CM2 = 2.5, 4.0, 2.0, 10.0
W, MIN_COV, ERODE, MIN_SEG_MM = 20, 0.6, 1, 30.0
v1.MIN_SEG_MM = MIN_SEG_MM  # curve_metrics reads the module-level constant

def fit_sheet(pts, comp=None):
    """robust height-field fit. Returns grid H (median h of kept points), valid mask, keep (per point), a/b/h, edges."""
    c = pts.mean(0); _, _, Vt = np.linalg.svd(pts - c, full_matrices=False)
    q = pts - c; a, b, h = q @ Vt[0], q @ Vt[1], q @ Vt[2]
    ea = np.arange(a.min(), a.max() + GRID, GRID); eb = np.arange(b.min(), b.max() + GRID, GRID)
    ia = np.clip(np.digitize(a, ea) - 1, 0, len(ea) - 2); ib = np.clip(np.digitize(b, eb) - 1, 0, len(eb) - 2)
    keep = np.ones(len(h), bool); comp = np.zeros(len(h), int) if comp is None else comp
    for s in (20.0, 10.0, 10.0):
        H = binned_statistic_2d(a[keep], b[keep], h[keep], "median", bins=[ea, eb]).statistic; m = np.isfinite(H)
        if m.sum() < 20: break
        dev = np.abs(h - nconv_twice(H, m, s / GRID)[ia, ib])
        # reject whole detached pieces lying off the sheet (false detections / parallel structures), and single
        # points very far off; a genuine zig-zag is one connected sheet and is kept
        cdev = pd.Series(dev).groupby(comp).median()
        keep = (cdev.reindex(comp).values <= TOL_COMP) & (dev <= TOL_PT)
    H = binned_statistic_2d(a[keep], b[keep], h[keep], "median", bins=[ea, eb]).statistic; m = np.isfinite(H)
    lab, nl = ndi.label(m, np.ones((3, 3)))
    if nl:
        sz = np.bincount(lab.ravel()) * GRID * GRID / 100; small = sz < MIN_ISLAND_CM2; small[0] = False
        drop = small[lab]; keep &= ~drop[ia, ib]; m &= ~drop; H[~m] = np.nan
    return H, m, keep

def window_metrics(H, m):
    area = m.sum() * GRID * GRID / 100
    if area < MIN_AREA_CM2: return dict(area_cm2=area, n_windows=0)
    hf, wf = nconv(H, m, SIG_F / GRID); hl = nconv_twice(H, m, SIG_L / GRID)
    core = ndi.binary_erosion(m, iterations=ERODE) & (wf > 0.5)
    fy, fx = np.gradient(hf, GRID); ly, lx = np.gradient(hl, GRID)
    nf = np.stack([-fy, -fx, np.ones_like(fx)], -1); nl_ = np.stack([-ly, -lx, np.ones_like(lx)], -1)
    nf /= np.linalg.norm(nf, axis=-1, keepdims=True); nl_ /= np.linalg.norm(nl_, axis=-1, keepdims=True)
    ang = np.degrees(np.arccos(np.clip((nf * nl_).sum(-1), -1, 1)))
    sf, sl = np.sqrt(1 + fx**2 + fy**2), np.sqrt(1 + lx**2 + ly**2)
    fyy, _ = np.gradient(fy, GRID); fxy, fxx = np.gradient(fx, GRID)
    Hc = np.abs(((1 + fx**2) * fyy - 2 * fx * fy * fxy + (1 + fy**2) * fxx) / (2 * (1 + fx**2 + fy**2) ** 1.5))
    r = hf - hl; rows = []; st = W // 2
    for i in range(0, max(core.shape[0] - W, 0) + 1, st):
        for j in range(0, max(core.shape[1] - W, 0) + 1, st):
            c = core[i:i + W, j:j + W]
            if c.size < W * W or c.mean() < MIN_COV: continue
            rr = r[i:i + W, j:j + W][c]
            rows.append(dict(rms=np.sqrt((rr**2).mean()), p95=np.percentile(np.abs(rr), 95), ang=ang[i:i + W, j:j + W][c].mean(),
                             aex=(sf[i:i + W, j:j + W][c].sum() / sl[i:i + W, j:j + W][c].sum() - 1) * 100, H=Hc[i:i + W, j:j + W][c].mean()))
    out = dict(area_cm2=area, n_windows=len(rows))
    if rows:
        d = pd.DataFrame(rows).mean()
        out.update(rough_rms_mm=d.rms, rough_p95_mm=d.p95, ang_irreg_deg=d.ang, area_excess_pct=d.aex, meanH_abs=d.H)
    return out

def sagittal(mk, sp):
    segs = []
    for x in np.unique(np.nonzero(mk)[2]):
        zz, yy = np.nonzero(mk[:, :, x])
        if len(zz) < 20: continue
        segs += curve_metrics(zz * sp[0], yy * sp[1])
    if not segs: return {}
    d = pd.DataFrame(segs); w = d.len / d.len.sum()
    return dict(n_segments=len(d), kappa_mean=(w * d.kmean).sum(), kappa_sd=(w * d.ksd).sum(),
                tort_endpoints=(w * d.tort).sum(), rough2d_rms_mm=(w * d.r2).sum())

def noise_hu(ds, cid):
    """robust noise of lung parenchyma: MAD of CT minus 3x3x3 local mean, in eroded lung, HU < -750 (no vessels)."""
    ct = sitk.GetArrayFromImage(sitk.ReadImage(f"{B}/data/{ds}/images/{cid}_0000.nii.gz")).astype(np.float32)
    lung = sitk.GetArrayFromImage(sitk.ReadImage(f"{B}/data/{ds}/gt/{cid}.nii.gz")) > 0
    zs = np.nonzero(lung.any((1, 2)))[0]; zc = (zs.min() + zs.max()) // 2; sl = slice(max(zc - 20, 0), zc + 20)
    ct, lung = ct[sl], ndi.binary_erosion(lung[sl], iterations=3)
    hp = ct - ndi.uniform_filter(ct, 3); msk = lung & (ct < -750)
    x = hp[msk]; return float(1.4826 * np.median(np.abs(x - np.median(x)))) if x.size > 1000 else np.nan

def run(args):
    ds, vis, cid = args
    img = sitk.ReadImage(f"{B}/fissures/{ds}/{vis}/{cid}.nii.gz"); V = sitk.GetArrayFromImage(img); sp = img.GetSpacing()[::-1]
    nz = noise_hu(ds, cid); rows = []
    for k, n in NAMES.items():
        mk0 = V == k; idx = np.argwhere(mk0)
        if len(idx) < 100: continue
        cl, _ = ndi.label(mk0, np.ones((3, 3, 3)))
        H, m, keep = fit_sheet(idx * np.array(sp), cl[tuple(idx.T)])
        r = dict(case=cid, fissure=n, slice_mm=round(sp[0], 2), noise_hu=nz, n_vox=len(idx), rejected_frac=1 - keep.mean(), **window_metrics(H, m))
        if r.get("n_windows", 0) > 0:
            mk = np.zeros(V.shape, bool); mk[tuple(idx[keep].T)] = True; r.update(sagittal(mk, sp))
        rows.append(r)
    print(cid, flush=True); return rows

if __name__ == "__main__":
    ds, vis = sys.argv[1], sys.argv[2]
    cases = sys.argv[3:] or sorted(os.path.basename(p)[:-7] for p in glob.glob(f"{B}/fissures/{ds}/{vis}/*.nii.gz"))
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4))) as p: rows = sum(p.map(run, [(ds, vis, c) for c in cases]), [])
    pd.DataFrame(rows).to_csv(f"{B}/results/{ds}_roughness_v2_{vis}.csv", index=False)
