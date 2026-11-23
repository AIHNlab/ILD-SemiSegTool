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


def _roughness(mk0: np.ndarray, sp_zyx) -> Dict[str, Any]:
    """fissure_roughness_v2.run for one fissure mask (z, y, x)."""
    from lib.lobes_border import fissure_roughness_v2 as v2

    idx = np.argwhere(mk0)
    if len(idx) < 100:
        return {}
    cl, _ = ndi.label(mk0, np.ones((3, 3, 3)))
    H, m, keep = v2.fit_sheet(idx * np.array(sp_zyx), cl[tuple(idx.T)])
    r = dict(rejected_frac=1 - keep.mean(), **v2.window_metrics(H, m))
    if r.get("n_windows", 0) > 0:
        mk = np.zeros(mk0.shape, bool)
        mk[tuple(idx[keep].T)] = True
        r.update(v2.sagittal(mk, sp_zyx))
    digits = {"n_windows": 0, "n_segments": 0, "area_cm2": 1, "rough_rms_mm": 2, "rough_p95_mm": 2,
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

    lobes = _viewer_image(lobes_zyx, geometry, np.uint8)
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

    meta = {"fissures": results, "seconds": round(time.time() - start, 1)}
    logger.info(f"Fissure analysis: {meta}")
    return encode_rle(visible_zyx.ravel()), meta
