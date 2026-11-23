"""Splits a whole-airway mask into trachea and bronchi - the viewer's
"Airway Split" task, run on the result of the nnunet_airways model.

The method itself is lib/trachea_carina_pipeline.py (rule-based, no AI): it
finds the airway tree's centreline, the top of the trachea and the carina, and
marks the airway down to 5 mm above the carina as trachea. Everything else in
the airway mask is bronchi, so trachea + bronchi == the airway mask given.

Input/output are the run-length labelmaps the viewer and server exchange
(lib/label_upload.py), in the viewer's voxel order, with the volume's geometry
(sizes, spacing, direction rows per axis in LPS world space) - see
user_context._airway_split.
"""

import logging
import time
from typing import Any, Dict, Tuple

import numpy as np
from scipy import ndimage

from lib.label_upload import decode_rle, encode_rle

logger = logging.getLogger(__name__)

TRACHEA, BRONCHI = 1, 2
CROP_MARGIN = 4  # voxels kept around the airway's bounding box


def _to_lps(arr, spacing, direction):
    """Reorders/flips the axes so index 0/1/2 grows towards patient
    Left/Posterior/Superior - the convention the pipeline relies on (the
    trachea's top is the highest index 2; the carina's branches split along
    index 0). Returns (array, spacing, undo)."""
    d = np.asarray(direction, dtype=np.float64).reshape(3, 3)  # row a: world direction of axis a
    world_of_axis = [int(np.argmax(np.abs(d[a]))) for a in range(3)]
    if sorted(world_of_axis) != [0, 1, 2]:
        raise ValueError("the scan is too oblique to tell its left/back/up axes apart")
    axis_for_world = [world_of_axis.index(w) for w in range(3)]
    flips = [d[axis_for_world[w], w] < 0 for w in range(3)]
    out = np.transpose(arr, axis_for_world)
    for w in range(3):
        if flips[w]:
            out = np.flip(out, axis=w)
    out_spacing = np.array([spacing[axis_for_world[w]] for w in range(3)], dtype=np.float64)

    def undo(a):
        for w in range(3):
            if flips[w]:
                a = np.flip(a, axis=w)
        return np.transpose(a, np.argsort(axis_for_world))

    return np.ascontiguousarray(out), out_spacing, undo


def _find_trachea(mask, spacing):
    """Runs the pipeline on a binary airway mask (LPS-ordered, cropped).
    Returns (trachea mask on the same grid, metrics)."""
    from lib import trachea_carina_pipeline as p

    iso = p.TARGET_SPACING
    factors = spacing / iso
    resampled = ndimage.zoom(mask.astype(np.float32), factors, order=1) > 0.5
    airway = p.largest_component(resampled.astype(np.uint8))
    skel = p.skeletonize(airway.astype(bool))
    G = p.build_skeleton_graph(skel)
    B = p.contract_short_edges(p.reduce_to_branch_graph(G))
    root = p.find_root(B)
    B = p.prune_short_spurs(B, protect=frozenset([root]))
    carina, trail = p.find_carina(B, root)
    path = p.get_full_path(B, trail)
    trimmed, trimmed_phys, cut_point, tangent, length = p.trim_to_cut_point(path)
    candidates = p.assign_trachea_mask(airway, G, set(trimmed))
    voxels = p.apply_cut_plane(candidates, cut_point, tangent)

    trachea_iso = np.zeros(airway.shape, dtype=bool)
    if len(voxels):
        trachea_iso[voxels[:, 0], voxels[:, 1], voxels[:, 2]] = True

    # Back onto the original grid: ndimage.zoom maps output index o to input
    # o * (in - 1) / (out - 1) per axis, so original index i sits at
    # i * (out - 1) / (in - 1) on the resampled grid.
    scale = [(o - 1) / max(i - 1, 1) for o, i in zip(trachea_iso.shape, mask.shape)]
    idx = np.nonzero(mask)
    coords = [idx[a] * scale[a] for a in range(3)]
    on_trachea = ndimage.map_coordinates(trachea_iso.astype(np.uint8), coords, order=0, mode="nearest") > 0
    trachea = np.zeros(mask.shape, dtype=bool)
    trachea[tuple(i[on_trachea] for i in idx)] = True

    root_mm = np.array(root, dtype=np.float64) * iso
    carina_mm = np.array(carina, dtype=np.float64) * iso
    metrics = {
        "trachea_length_mm": round(float(length), 1),
        "trachea_straight_mm": round(float(np.linalg.norm(carina_mm - root_mm)), 1),
    }
    try:
        metrics.update(_cross_sections(p, airway, trimmed_phys, length, metrics["trachea_straight_mm"]))
    except Exception as e:  # the split itself is still good
        logger.warning(f"Airway split: cross-section measurements failed: {e}")
    return trachea, metrics


def _cross_sections(p, airway, trimmed_phys, length, straight):
    """The pipeline's trachea measurements: cross-sections every 1 mm along
    a smoothed centreline (area, width, depth, tracheal index), summarised
    by its derive_summary."""
    splines, tt, fine_arclen, total = p.fit_centerline_spline(trimmed_phys)
    points, tangents, arclens = p.sample_uniform(splines, tt, fine_arclen, total)
    rows = []
    for point, tangent, arclen in zip(points, tangents, arclens):
        m = p.cross_section_metrics(airway, point, tangent)
        if m is not None:
            m["arclen_from_root_mm"] = arclen
            rows.append(m)
    if not rows:
        return {}
    summary, _ = p.derive_summary(rows, length, max(straight, 1e-9))

    def num(key, digits=1):
        v = summary.get(key)
        return None if v is None or not np.isfinite(v) else round(float(v), digits)

    return {
        "tortuosity": num("tortuosity", 2),
        "mean_area_mm2": num("mean_area_mm2"),
        "min_area_mm2": num("min_area_mm2"),
        "mean_tracheal_index": num("mean_tracheal_index", 2),
        "saber_sheath": bool(summary.get("any_saber_sheath")),
        "area_2cm_above_carina_mm2": num("area_mm2_at_2cm_above_carina"),
        "tracheal_index_2cm_above_carina": num("tracheal_index_at_2cm_above_carina", 2),
        "cross_sections": int(summary.get("n_cross_sections") or 0),
    }


def split_airways(raw: bytes, geometry: Dict[str, Any]) -> Tuple[bytes, Dict[str, Any]]:
    """(run-length labelmap: 1 = trachea, 2 = bronchi, 0 elsewhere, meta)
    from a run-length airway mask (any non-zero value = airway)."""
    start = time.time()
    sizes = [int(s) for s in geometry["sizes"]]
    spacing = [float(s) for s in geometry["spacing"]]
    direction = [float(d) for d in geometry["direction"]]
    if len(sizes) != 3 or len(spacing) != 3 or len(direction) != 9:
        raise ValueError("bad geometry")

    flat = decode_rle(raw, int(np.prod(sizes)))
    airway = flat.reshape(sizes, order="F") > 0  # viewer order: x fastest
    if not airway.any():
        raise ValueError("there are no airway voxels to split - run nnunet_airways first")

    lps, lps_spacing, undo = _to_lps(airway, spacing, direction)
    nz = np.nonzero(lps)
    lo = [max(int(n.min()) - CROP_MARGIN, 0) for n in nz]
    hi = [min(int(n.max()) + CROP_MARGIN + 1, s) for n, s in zip(nz, lps.shape)]
    crop = lps[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]

    try:
        trachea_crop, metrics = _find_trachea(crop, lps_spacing)
    except ValueError as e:
        raise ValueError(f"could not find the trachea and carina in this airway mask ({e})") from e

    labels = np.zeros(lps.shape, dtype=np.uint8)
    labels[lps] = BRONCHI
    region = labels[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
    region[trachea_crop] = TRACHEA
    out = undo(labels)

    trachea_n = int(np.count_nonzero(out == TRACHEA))
    if trachea_n == 0:
        raise ValueError("no trachea found in this airway mask")
    bronchi_n = int(np.count_nonzero(out == BRONCHI))
    voxel_ml = float(np.prod(spacing)) / 1000.0
    meta = {
        "trachea_voxels": trachea_n,
        "bronchi_voxels": bronchi_n,
        "trachea_volume_ml": round(trachea_n * voxel_ml, 1),
        "bronchi_volume_ml": round(bronchi_n * voxel_ml, 1),
        **metrics,
        "seconds": round(time.time() - start, 1),
    }
    logger.info(f"Airway split: {meta}")
    return encode_rle(out.ravel(order="F")), meta
