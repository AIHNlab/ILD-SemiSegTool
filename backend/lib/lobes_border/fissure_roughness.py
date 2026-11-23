"""Fissure 'zig-zag' / roughness metrics on visible-fissure masks.

For each fissure (1=left oblique, 2=right oblique, 3=right horizontal) of a visible-fissure mask:

3D (surface as height field over its best-fit plane, 1 mm grid):
  h      = median signed distance of fissure voxels to the best-fit (PCA) plane per grid cell
  h_f    = h smoothed at SIG_F mm  (removes voxel staircase / detection noise)
  h_L    = h smoothed at SIG_L mm  (large-scale anatomical shape)
  r      = h_f - h_L               (zig-zag residual)
  rough_rms_mm    RMS of r                              (amplitude of deviation from a smooth sheet)
  rough_p95_mm    95th percentile |r|
  ang_irreg_deg   mean angle between local normals of h_f and h_L
  area_excess_pct (area(h_f) / area(h_L) - 1) * 100     (3D tortuosity)
  meanH_abs       mean |mean curvature| of h_f (1/mm)   (3D analogue of mean |kappa|)

2D (sagittal slices = how radiologists read fissures; fissure in each slice = curve h(t)):
  kappa_mean      length-weighted mean |kappa| of the SIG_F-smoothed curve (1/mm)
  kappa_sd        SD of kappa
  tort_endpoints  arc length / chord of each contiguous segment (length-weighted)
  rough2d_rms_mm  RMS of curve minus its SIG_L-smoothed version
Usage: fissure_roughness.py <ds> <visible_dir_name> [cases...]  -> results/<ds>_roughness_<visible_dir_name>.csv
Also importable: surface_metrics(pts_mm), sagittal_metrics(mask_k, spacing)."""
import sys, os, glob, numpy as np, pandas as pd, SimpleITK as sitk
from scipy import ndimage as ndi
from scipy.stats import binned_statistic_2d
from multiprocessing import Pool
B = "/storage/scratch/users/vd24z940/lobe_bench"
SIG_F, SIG_L, GRID, MIN_AREA_CM2, MIN_SEG_MM = 1.5, 10.0, 1.0, 10.0, 20.0
NAMES = {1: "left_oblique", 2: "right_oblique", 3: "right_horizontal"}

def nconv(h, m, s):
    """normalized convolution: Gaussian smoothing of h on valid cells m (NaN-aware)."""
    w = ndi.gaussian_filter(m.astype(float), s); v = ndi.gaussian_filter(np.where(m, h, 0.0), s)
    return v / np.maximum(w, 1e-9), w

def nconv_twice(h, m, s):
    """bias-corrected large-scale smoother (Tukey twicing, 2G - GG): preserves quadratic bends, so the
    normal anatomical curvature of the fissure is not mistaken for roughness."""
    g1, _ = nconv(h, m, s); g2, _ = nconv(g1, m, s); return 2 * g1 - g2

def smooth1d_twice(x, s):
    g1 = ndi.gaussian_filter1d(x, s, mode="nearest"); return 2 * g1 - ndi.gaussian_filter1d(g1, s, mode="nearest")

def surface_metrics(pts):
    """pts: (N,3) fissure voxel coordinates in mm."""
    c = pts.mean(0); _, _, Vt = np.linalg.svd(pts - c, full_matrices=False)
    u, v, n = Vt[0], Vt[1], Vt[2]; q = pts - c
    a, b, h = q @ u, q @ v, q @ n
    ea = np.arange(a.min(), a.max() + GRID, GRID); eb = np.arange(b.min(), b.max() + GRID, GRID)
    H = binned_statistic_2d(a, b, h, "median", bins=[ea, eb]).statistic
    m = np.isfinite(H); area = m.sum() * GRID * GRID / 100
    if area < MIN_AREA_CM2: return dict(area_cm2=area)
    hf, wf = nconv(H, m, SIG_F / GRID); hl = nconv_twice(H, m, SIG_L / GRID)
    core = ndi.binary_erosion(m, iterations=2) & (wf > 0.5)  # avoid gap / border effects
    if core.sum() < 50: return dict(area_cm2=area)
    r = (hf - hl)[core]
    fy, fx = np.gradient(hf, GRID); ly, lx = np.gradient(hl, GRID)
    nf = np.stack([-fy, -fx, np.ones_like(fx)], -1); nl = np.stack([-ly, -lx, np.ones_like(lx)], -1)
    nf /= np.linalg.norm(nf, axis=-1, keepdims=True); nl /= np.linalg.norm(nl, axis=-1, keepdims=True)
    ang = np.degrees(np.arccos(np.clip((nf * nl).sum(-1), -1, 1)))[core]
    af = np.sqrt(1 + fx**2 + fy**2)[core].sum(); al = np.sqrt(1 + lx**2 + ly**2)[core].sum()
    fyy, fyx = np.gradient(fy, GRID); fxy, fxx = np.gradient(fx, GRID)
    Hc = ((1 + fx**2) * fyy - 2 * fx * fy * fxy + (1 + fy**2) * fxx) / (2 * (1 + fx**2 + fy**2) ** 1.5)
    return dict(area_cm2=area, rough_rms_mm=np.sqrt((r**2).mean()), rough_p95_mm=np.percentile(np.abs(r), 95),
                ang_irreg_deg=ang.mean(), area_excess_pct=(af / al - 1) * 100, meanH_abs=np.abs(Hc[core]).mean())

def curve_metrics(z, y):
    """one sagittal slice: points (z,y) in mm -> list of segment dicts."""
    P = np.stack([z, y], 1); c = P.mean(0); _, _, Vt = np.linalg.svd(P - c, full_matrices=False)
    t, h = (P - c) @ Vt[0], (P - c) @ Vt[1]
    e = np.arange(t.min(), t.max() + GRID, GRID); idx = np.digitize(t, e) - 1
    hb = pd.Series(h).groupby(idx).median(); hc = np.full(len(e), np.nan); hc[hb.index.values] = hb.values
    ok = np.isfinite(hc); out = []
    # fill gaps <= 2 mm, split at larger gaps
    s = pd.Series(hc).interpolate(limit=2, limit_area="inside").values; ok = np.isfinite(s)
    lab, nl = ndi.label(ok)
    for i in range(1, nl + 1):
        seg = s[lab == i]
        if len(seg) * GRID < MIN_SEG_MM: continue
        f = ndi.gaussian_filter1d(seg, SIG_F / GRID, mode="nearest"); L = smooth1d_twice(seg, SIG_L / GRID)
        d1 = np.gradient(f, GRID); d2 = np.gradient(d1, GRID); k = d2 / (1 + d1**2) ** 1.5
        trim = slice(3, -3); arc = np.sqrt(1 + d1**2).sum() * GRID
        chord = np.hypot((len(f) - 1) * GRID, f[-1] - f[0])
        out.append(dict(len=arc, kmean=np.abs(k[trim]).mean(), ksd=k[trim].std(), tort=arc / chord,
                        r2=np.sqrt(((f - L)[trim] ** 2).mean())))
    return out

def sagittal_metrics(mk, sp):
    """mk: boolean mask (z,y,x) of one fissure; sp: spacing (z,y,x) in mm. Sagittal slice = fixed x."""
    segs = []
    for x in np.unique(np.nonzero(mk)[2]):
        zz, yy = np.nonzero(mk[:, :, x])
        if len(zz) < 20: continue
        segs += curve_metrics(zz * sp[0], yy * sp[1])
    if not segs: return {}
    d = pd.DataFrame(segs); w = d.len / d.len.sum()
    return dict(n_segments=len(d), kappa_mean=(w * d.kmean).sum(), kappa_sd=(w * d.ksd).sum(),
                tort_endpoints=(w * d.tort).sum(), rough2d_rms_mm=(w * d.r2).sum())

def run(args):
    ds, vis, cid = args
    img = sitk.ReadImage(f"{B}/fissures/{ds}/{vis}/{cid}.nii.gz"); V = sitk.GetArrayFromImage(img); sp = img.GetSpacing()[::-1]
    rows = []
    for k, n in NAMES.items():
        mk = V == k
        if mk.sum() < 100: continue
        pts = np.argwhere(mk) * np.array(sp)
        r = dict(case=cid, fissure=n, slice_mm=round(sp[0], 2), **surface_metrics(pts))
        if "rough_rms_mm" in r: r.update(sagittal_metrics(mk, sp))
        rows.append(r)
    print(cid, flush=True); return rows

if __name__ == "__main__":
    ds, vis = sys.argv[1], sys.argv[2]
    cases = sys.argv[3:] or sorted(os.path.basename(p)[:-7] for p in glob.glob(f"{B}/fissures/{ds}/{vis}/*.nii.gz"))
    with Pool(int(os.environ.get("SLURM_CPUS_PER_TASK", 4))) as p: rows = sum(p.map(run, [(ds, vis, c) for c in cases]), [])
    pd.DataFrame(rows).to_csv(f"{B}/results/{ds}_roughness_{vis}.csv", index=False)
