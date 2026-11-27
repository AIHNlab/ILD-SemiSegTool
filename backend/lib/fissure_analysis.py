"""Fissure analysis after a lobe segmentation - the viewer's "Fissure Analysis"
task, run on the result of the nnunet_lobes model.

The methods are the scripts in lib/lobes_border/ (written for batch runs on
NIfTI files); this module runs them on one scan from the viewer:

1. Fissure planes (fissure_planes.fissures, mirrored in _planes - that
   module lists the cluster's data folders when imported, so it can't be
   imported here): the 2-voxel border between neighbouring lobes.
   1 = left oblique (LUL|LLL), 2 = right oblique (RUL+RML|RLL),
   3 = right horizontal (RUL|RML).
2. Visible-fissure detection (fissure_detect: rs, hessian_eig and the same
   parameters): within BAND mm of each plane, bright plate-like voxels (Hessian)
   whose plate normal is within ANG degrees of the plane normal. The loop of
   fissure_detect.run is mirrored here because run() reads/writes files.
3. Completeness (fissure_completeness's formula): FI% = share of plane voxels
   with a detected visible-fissure voxel of the same fissure within TOL mm.
4. Zig-zag metrics (fissure_roughness_v2, which uses fissure_roughness's
   helpers): the visible fissure fitted as a smooth sheet (outliers rejected),
   roughness / angular irregularity / area excess / mean |H| in 20 mm windows,
   2D sagittal curve metrics, and the quality flags rejected_frac and noise_hu.
   v2's run() and noise_hu() read files, so their few lines are mirrored here.
   One change to v2: a fissure is split into patches first (detections no
   more than PATCH_GAP_MM apart) and each patch of at least MIN_AREA_CM2 is
   fitted as its own sheet - over the plane of the patch's largest connected
   piece, so scattered fragments that joined the patch can't tilt it; the
   20 mm windows of all patches are then pooled.
   v2 fits one sheet over one plane for the whole fissure, which can't follow
   a fissure that bends strongly between separate visible stretches (e.g. a
   right oblique fissure seen in two patches 35 deg apart): it rejected the
   real patches as "off the sheet" and kept only fragments. A fissure seen
   as one patch is measured exactly as in v2.

Isotropic voxels (geometry["isotropic"], on unless false): CT and lobes are
first resampled to ISO_MM cubes - the grid fissure_detect already detects on
- and planes, completeness and the zig-zag metrics are all computed there, so
they don't depend on the scan's slice spacing (e.g. sagittal curves sampled
every 1-5 mm in z). The visible fissures are then mapped back onto the
viewer's grid for display. A scan whose voxels are already cubes is used as is.

Input: the viewer's lobe mask, run-length encoded (lib/label_upload.py) with
values 1 = LUL, 2 = LLL, 3 = RUL, 4 = RML, 5 = RLL, and the volume's geometry
(sizes, spacing, direction rows per axis, origin; LPS). The scan's CT comes from
the user's datastore and is resampled onto that grid, so everything lines up
voxel for voxel with the viewer. Output: the visible fissures (1..3) in the same
form, plus per-fissure results.
"""

import logging
import time
from typing import Any, Dict, Tuple

import numpy as np
import SimpleITK as sitk
from scipy import ndimage as ndi

from lib.label_upload import decode_rle, encode_rle

logger = logging.getLogger(__name__)

FISSURES = {1: "left_oblique", 2: "right_oblique", 3: "right_horizontal"}
COMPLETENESS_TOL_MM = 3.0  # fissure_completeness.TOL
ISO_MM = 0.7  # fissure_detect.ISO
PATCH_GAP_MM = 5.0  # detections closer than this belong to the same patch


# fissure_planes.FISS: fissure -> (lobe group A, lobe group B)
FISS = {"left_oblique": ({1}, {2}), "right_oblique": ({3, 4}, {5}), "right_horizontal": ({3}, {4})}


def _planes(L: np.ndarray) -> np.ndarray:
    """fissure_planes.fissures: voxels of group A 6-adjacent to group B, plus
    B adjacent to A (2 voxels thick). Labels 1..3 in FISS order."""
    st = ndi.generate_binary_structure(3, 1)
    out = np.zeros(L.shape, np.uint8)
    for k, (_, (a, b)) in enumerate(FISS.items(), 1):
        A, Bm = np.isin(L, list(a)), np.isin(L, list(b))
        out[(A & ndi.binary_dilation(Bm, st)) | (Bm & ndi.binary_dilation(A, st))] = k
    return out


def _viewer_image(arr_zyx: np.ndarray, geometry: Dict[str, Any], pixel_type) -> sitk.Image:
    """An ITK image on the viewer volume's grid. The viewer's voxel order is
    x fastest, so a (z, y, x) C-order array is that same memory."""
    img = sitk.GetImageFromArray(arr_zyx.astype(pixel_type, copy=False))
    img.SetSpacing([float(s) for s in geometry["spacing"]])
    img.SetOrigin([float(o) for o in geometry["origin"]])
    rows = np.asarray(geometry["direction"], dtype=np.float64).reshape(3, 3)  # row a: direction of axis a
    img.SetDirection(rows.T.ravel().tolist())  # ITK: column a is the direction of axis a
    return img


def _detect_visible(ct: sitk.Image, lobes: sitk.Image, planes: sitk.Image) -> np.ndarray:
    """fissure_detect.run's detection on images in memory -> visible-fissure
    labels (1..3) on the lobes' grid."""
    from lib.lobes_border import fissure_detect as fd

    cti = fd.rs(ct, sitk.sitkLinear)
    v = sitk.GetArrayFromImage(cti)
    P = sitk.GetArrayFromImage(fd.rs(planes, sitk.sitkNearestNeighbor))
    L = sitk.GetArrayFromImage(fd.rs(lobes, sitk.sitkNearestNeighbor))
    bb = np.argwhere(P > 0)
    lo = np.maximum(bb.min(0) - 15, 0)
    hi = bb.max(0) + 16
    sl = tuple(slice(a, b) for a, b in zip(lo, hi))
    v, P, L = v[sl], P[sl], L[sl]
    vc = np.clip(v, -1000, -500)
    res = np.zeros(v.shape, np.uint8)
    groups = {1: ({1}, {2}), 2: ({3, 4}, {5}), 3: ({3}, {4})}
    for k, (a, b) in groups.items():
        if not (P == k).any():
            continue
        d = ndi.distance_transform_edt(P != k) * fd.ISO
        band = (d <= fd.BAND) & np.isin(L, [1, 2, 3, 4, 5]) & (v > -1000) & (v < -300)
        # plane normal = gradient of smoothed indicator(A) - indicator(B)
        ind = np.isin(L, list(a)).astype(np.float32) - np.isin(L, list(b)).astype(np.float32)
        g = np.stack(np.gradient(ndi.gaussian_filter(ind, 3.0 / fd.ISO)), -1)
        idx = np.nonzero(band)
        n = g[idx]
        n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
        hit = np.zeros(len(idx[0]), bool)
        for s in fd.SIGMAS:
            w, e3 = fd.hessian_eig(vc, idx, s / fd.ISO)
            l2, l3 = w[:, 1], w[:, 2]
            ok = (
                (l3 < 0)
                & (np.abs(l2) / (np.abs(l3) + 1e-6) < fd.RS_MAX)
                & (-l3 > fd.CONTRAST)
                & (np.abs((e3 * n).sum(1)) > np.cos(np.deg2rad(fd.ANG)))
            )
            hit |= ok
        m = np.zeros(v.shape, bool)
        m[idx] = hit
        cc, nc = ndi.label(m, ndi.generate_binary_structure(3, 3))
        if nc:
            sizes = np.bincount(cc.ravel()) * fd.ISO * fd.ISO
            keep = sizes >= fd.MIN_CC_MM2
            keep[0] = False
            m = keep[cc]
        res[m] = k
    full = np.zeros(cti.GetSize()[::-1], np.uint8)
    full[sl] = res
    fi = sitk.GetImageFromArray(full)
    fi.CopyInformation(cti)
    return sitk.GetArrayFromImage(fd.rs(fi, sitk.sitkNearestNeighbor, ref=lobes))


def _isotropic_grid(ref: sitk.Image, mm: float) -> sitk.Image:
    """An empty image covering ref's extent with mm cubes (same origin and
    directions) - fissure_detect.rs's grid."""
    size = [max(1, int(round(n * s / mm))) for n, s in zip(ref.GetSize(), ref.GetSpacing())]
    grid = sitk.Image(size, sitk.sitkUInt8)
    grid.SetOrigin(ref.GetOrigin())
    grid.SetSpacing((mm,) * 3)
    grid.SetDirection(ref.GetDirection())
    return grid


def _to_viewer(labels: sitk.Image, viewer: sitk.Image) -> np.ndarray:
    """Labels 1..3 on a fine grid -> the viewer's (coarser) grid. Each label is
    resampled as a soft mask and kept where it covers >= 30 % of a voxel - plain
    nearest-neighbour would drop parts of a thin sheet between slices."""
    arr = sitk.GetArrayFromImage(labels)
    out = np.zeros(sitk.GetArrayFromImage(viewer).shape, np.uint8)
    best = np.zeros(out.shape, np.float32)
    for k in np.unique(arr[arr > 0]):
        m = sitk.GetImageFromArray((arr == k).astype(np.float32))
        m.CopyInformation(labels)
        f = sitk.GetArrayFromImage(sitk.Resample(m, viewer, sitk.Transform(), sitk.sitkLinear, 0.0, sitk.sitkFloat32))
        take = (f >= 0.3) & (f > best)
        out[take], best[take] = k, f[take]
    return out


def _num(v, digits=2):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(v, digits) if np.isfinite(v) else None


def _noise_hu(ct_zyx: np.ndarray, lung: np.ndarray) -> float:
    """fissure_roughness_v2.noise_hu on arrays in memory: robust noise of the
    lung parenchyma - MAD of CT minus its 3x3x3 local mean, in the eroded lung,
    HU < -750 (no vessels), over the 40 slices around the lung's middle."""
    zs = np.nonzero(lung.any((1, 2)))[0]
    zc = (zs.min() + zs.max()) // 2
    sl = slice(max(zc - 20, 0), zc + 20)
    ct, lung = ct_zyx[sl].astype(np.float32), ndi.binary_erosion(lung[sl], iterations=3)
    hp = ct - ndi.uniform_filter(ct, 3)
    msk = lung & (ct < -750)
    x = hp[msk]
    return float(1.4826 * np.median(np.abs(x - np.median(x)))) if x.size > 1000 else float("nan")


def _patches(mk0: np.ndarray, sp_zyx) -> Tuple[np.ndarray, int]:
    """Labels (1..n) of the patches of a visible-fissure mask: detections no
    more than PATCH_GAP_MM apart are one patch."""
    idx = np.argwhere(mk0)
    lo = np.maximum(idx.min(0) - 1, 0)
    hi = idx.max(0) + 2
    sl = tuple(slice(a, b) for a, b in zip(lo, hi))
    near = ndi.distance_transform_edt(~mk0[sl], sampling=sp_zyx) <= PATCH_GAP_MM / 2
    groups, n = ndi.label(near, np.ones((3, 3, 3)))
    out = np.zeros(mk0.shape, np.int32)
    out[sl] = np.where(mk0[sl], groups, 0)
    return out, n


def _fit_sheet(pts: np.ndarray, comp: np.ndarray):
    """fissure_roughness_v2.fit_sheet, with the height field taken over the
    best-fit plane of the largest piece (comp) instead of all points - the
    rest of the robust fit (outlier rejection, island removal) is v2's."""
    import pandas as pd
    from scipy.stats import binned_statistic_2d

    from lib.lobes_border import fissure_roughness_v2 as v2
    from lib.lobes_border.fissure_roughness import GRID, nconv_twice

    ids, counts = np.unique(comp, return_counts=True)
    anchor = pts[comp == ids[np.argmax(counts)]]
    c = anchor.mean(0)
    _, _, Vt = np.linalg.svd(anchor - c, full_matrices=False)
    q = pts - c
    a, b, h = q @ Vt[0], q @ Vt[1], q @ Vt[2]
    ea = np.arange(a.min(), a.max() + GRID, GRID)
    eb = np.arange(b.min(), b.max() + GRID, GRID)
    ia = np.clip(np.digitize(a, ea) - 1, 0, len(ea) - 2)
    ib = np.clip(np.digitize(b, eb) - 1, 0, len(eb) - 2)
    keep = np.ones(len(h), bool)
    for s in (20.0, 10.0, 10.0):
        H = binned_statistic_2d(a[keep], b[keep], h[keep], "median", bins=[ea, eb]).statistic
        m = np.isfinite(H)
        if m.sum() < 20:
            break
        dev = np.abs(h - nconv_twice(H, m, s / GRID)[ia, ib])
        cdev = pd.Series(dev).groupby(comp).median()
        keep = (cdev.reindex(comp).values <= v2.TOL_COMP) & (dev <= v2.TOL_PT)
    H = binned_statistic_2d(a[keep], b[keep], h[keep], "median", bins=[ea, eb]).statistic
    m = np.isfinite(H)
    lab, nl = ndi.label(m, np.ones((3, 3)))
    if nl:
        sz = np.bincount(lab.ravel()) * GRID * GRID / 100
        small = sz < v2.MIN_ISLAND_CM2
        small[0] = False
        drop = small[lab]
        keep &= ~drop[ia, ib]
        m &= ~drop
        H[~m] = np.nan
    return H, m, keep


def _roughness(mk0: np.ndarray, sp_zyx) -> Dict[str, Any]:
    """fissure_roughness_v2.run for one fissure mask (z, y, x), fitted patch
    by patch (see the module docstring)."""
    from lib.lobes_border import fissure_roughness_v2 as v2

    idx = np.argwhere(mk0)
    if len(idx) < 100:
        return {}
    cl, _ = ndi.label(mk0, np.ones((3, 3, 3)))
    patch_of, n_patches = _patches(mk0, sp_zyx)
    patch = patch_of[tuple(idx.T)]
    keep = np.zeros(len(idx), bool)
    area, windows, measured = 0.0, [], 0
    for p in range(1, n_patches + 1):
        sel = np.nonzero(patch == p)[0]
        if len(sel) < 100:
            continue  # a fragment - not measurable on its own
        H, m, k = _fit_sheet(idx[sel] * np.array(sp_zyx), cl[tuple(idx[sel].T)])
        w = v2.window_metrics(H, m)
        if w.get("n_windows", 0) == 0 and w["area_cm2"] < v2.MIN_AREA_CM2:
            continue  # too small to measure: its detections count as rejected
        keep[sel] = k
        area += w["area_cm2"]
        measured += 1
        if w["n_windows"]:
            windows.append(w)
    n_windows = sum(w["n_windows"] for w in windows)
    r = dict(rejected_frac=1 - keep.mean(), area_cm2=area, n_windows=n_windows, n_patches=measured)
    if n_windows:
        # pooled over all windows = each patch weighted by its number of windows
        for key in ("rough_rms_mm", "rough_p95_mm", "ang_irreg_deg", "area_excess_pct", "meanH_abs"):
            r[key] = sum(w[key] * w["n_windows"] for w in windows) / n_windows
        mk = np.zeros(mk0.shape, bool)
        mk[tuple(idx[keep].T)] = True
        r.update(v2.sagittal(mk, sp_zyx))
    digits = {"n_windows": 0, "n_segments": 0, "n_patches": 0, "area_cm2": 1, "rough_rms_mm": 2, "rough_p95_mm": 2,
              "ang_irreg_deg": 1, "area_excess_pct": 2, "meanH_abs": 4, "kappa_mean": 4, "kappa_sd": 4,
              "tort_endpoints": 3, "rough2d_rms_mm": 2, "rejected_frac": 3}
    return {k: (int(v) if digits.get(k) == 0 else _num(v, digits.get(k, 3))) for k, v in r.items()}


def analyse_fissures(raw: bytes, geometry: Dict[str, Any], ct_path: str) -> Tuple[bytes, Dict[str, Any]]:
    """(run-length visible fissures: 1 = left oblique, 2 = right oblique,
    3 = right horizontal, 0 elsewhere; per-fissure results)."""
    start = time.time()
    sizes = [int(s) for s in geometry["sizes"]]
    if len(sizes) != 3 or len(geometry.get("spacing", [])) != 3 or len(geometry.get("direction", [])) != 9 \
            or len(geometry.get("origin", [])) != 3:
        raise ValueError("bad geometry")
    lobes_zyx = decode_rle(raw, int(np.prod(sizes))).reshape(sizes[::-1])
    if not np.isin(lobes_zyx, [1, 2, 3, 4, 5]).any():
        raise ValueError("there are no lobes to analyse - run nnunet_lobes first")

    viewer = _viewer_image(lobes_zyx, geometry, np.uint8)
    spacing = np.asarray(viewer.GetSpacing(), dtype=float)
    already_cubes = np.ptp(spacing) <= 0.01 * spacing.min()
    resampled = geometry.get("isotropic", True) is not False and not already_cubes
    lobes = viewer
    if resampled:
        lobes = sitk.Resample(viewer, _isotropic_grid(viewer, ISO_MM), sitk.Transform(), sitk.sitkNearestNeighbor, 0,
                              sitk.sitkUInt8)
        lobes_zyx = sitk.GetArrayFromImage(lobes)
    ct = sitk.Resample(sitk.ReadImage(ct_path, sitk.sitkFloat32), lobes, sitk.Transform(), sitk.sitkLinear, -1024.0,
                       sitk.sitkFloat32)

    # 1. planes
    planes_zyx = _planes(lobes_zyx)
    if not planes_zyx.any():
        raise ValueError("no fissure planes - the lobes don't touch each other")
    planes = sitk.GetImageFromArray(planes_zyx)
    planes.CopyInformation(lobes)

    # 2. visible fissures
    visible_zyx = _detect_visible(ct, lobes, planes)

    # 3. completeness, per fissure (fissure_completeness.py's formula)
    sp_zyx = tuple(float(s) for s in lobes.GetSpacing()[::-1])
    results = {}
    for k, name in FISSURES.items():
        p = planes_zyx == k
        if not p.any():
            continue  # lobe missing (e.g. resected) - fissure not evaluable
        v = visible_zyx == k
        if v.any():
            bb = np.argwhere(p | v)
            lo = np.maximum(bb.min(0) - 6, 0)
            hi = bb.max(0) + 7
            sl = tuple(slice(a, b) for a, b in zip(lo, hi))
            d = ndi.distance_transform_edt(~v[sl], sampling=sp_zyx)
            fi = float((d[p[sl]] <= COMPLETENESS_TOL_MM).mean())
        else:
            fi = 0.0
        results[name] = {
            # fissure_planes.py: plane voxels x in-plane voxel area / 2 (the plane is 2 voxels thick)
            "plane_area_cm2": round(float(p.sum() * sp_zyx[1] * sp_zyx[2] / 100 / 2), 1),
            "completeness_pct": round(100 * fi, 1),
        }

    # 4. zig-zag metrics
    ct_zyx = sitk.GetArrayFromImage(ct)
    try:
        noise = _noise_hu(ct_zyx, lobes_zyx > 0)
    except Exception as e:
        logger.warning(f"Fissure analysis: noise estimate failed: {e}")
        noise = float("nan")
    for k, name in FISSURES.items():
        if name not in results:
            continue
        try:
            results[name].update(_roughness(visible_zyx == k, sp_zyx))
        except Exception as e:  # completeness is still good
            logger.warning(f"Fissure analysis: roughness of {name} failed: {e}")
        results[name]["noise_hu"] = _num(noise)

    meta = {
        "fissures": results,
        # the grid everything was measured on (x, y, z mm)
        "analysis_spacing_mm": [round(float(s), 3) for s in lobes.GetSpacing()],
        "isotropic": bool(resampled or already_cubes),
        "seconds": round(time.time() - start, 1),
    }
    logger.info(f"Fissure analysis: {meta}")
    if resampled:
        visible = sitk.GetImageFromArray(visible_zyx)
        visible.CopyInformation(lobes)
        visible_zyx = _to_viewer(visible, viewer)
    return encode_rle(visible_zyx.ravel()), meta
