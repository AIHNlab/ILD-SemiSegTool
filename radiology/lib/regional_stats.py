"""12-region (2 sides x 3 craniocaudal zones x 2 depths) volumetric ILD
statistics, computed by combining a saved whole-lung mask (nnunet_lung)
with a saved ILD-class mask (nnunet_ild / sam2_ild) for the same image.

Both masks are written by their infer tasks via
`seg.CopyInformation(sitk.ReadImage(source_image_path))` before
`sitk.WriteImage(...)` (see lib/infers/nnunet.py and
lib/infers/sam2_interactive.py), so a lung save and an ILD save for the
same source image always share identical spacing/origin/direction - no
registration step is needed here, just a geometry equality check.

IMPORTANT - a saved label's voxel indices do NOT match a model config's
fixed `labels` dict (e.g. nnunet_lung.py's `{"lung": 1}`). The OHIF viewer
keeps one shared, session-global segmentation across every model/tab (see
MonaiLabelPanel.tsx's onInfo/updateView - this is what makes undo/redo and
multi-model workflows possible), so a class's voxel index is assigned
dynamically per session and can be completely different from the backend
model's own numbering. What IS reliable is `info["classes"]`
(MonaiLabelPanel.tsx's onClickSaveSegmentation), recorded at save time as
the class names actually present in that save, sorted ascending by their
live voxel index - see `_class_index_map` below, which reconstructs the
true index->name mapping from that instead of trusting any fixed config.

The "% affected" figure is intentionally pluggable (see `region_scorer`
below): the interim implementation derives it by counting ILD-mask voxels
per region, but this is meant to be swapped later for a call to a
purpose-built model that predicts %-affected directly from the region's
image data, without touching the region-splitting logic (steps 1-7).
"""

import logging
from datetime import datetime
from typing import Callable, Dict, List, Optional

import numpy as np
import SimpleITK as sitk
from scipy import ndimage

logger = logging.getLogger(__name__)

LUNG_MODELS = {"nnunet_lung"}
ILD_MODELS = {"nnunet_ild", "sam2_ild"}

ZONES = ["lower", "middle", "upper"]
DEPTHS = ["central", "peripheral"]
SIDES = ["left", "right"]

# compute_regional_stats always pairs the MOST RECENTLY SAVED lung segmentation
# with the most recently saved ILD segmentation - independently of each other,
# and independently of whatever was just run in the current session. Running
# only one model (e.g. just nnunet_lung) still produces a result by silently
# falling back to an older ILD save. This threshold flags that situation
# (`stale_pairing_warning` in the response) rather than fixing it silently -
# the caller decides whether a stale pairing is actually a problem.
STALE_PAIRING_SECONDS = 6 * 3600


def _format_ts(ts) -> Optional[str]:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else None


def _latest_tag_for_models(datastore, image: str, model_names) -> Optional[str]:
    label_ids = datastore.get_labels_by_image_id(image)
    candidates = []
    for tag, label_id in label_ids.items():
        info = datastore.get_label_info(label_id, tag)
        if info.get("model") in model_names:
            candidates.append((info.get("ts", 0), tag, info))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    return candidates[-1][1]


def _read_oriented(datastore, image: str, tag: str) -> sitk.Image:
    uri = datastore.get_label_uri(image, tag)
    img = sitk.ReadImage(uri)
    orienter = sitk.DICOMOrientImageFilter()
    orienter.SetDesiredCoordinateOrientation("LPS")
    return orienter.Execute(img)


def _class_index_map(info: Dict, arr: np.ndarray, tag: str) -> Dict[int, str]:
    """Reconstructs the true voxel-index -> class-name mapping for one saved
    label (see the module docstring for why this can't just be read off a
    model config). `info["classes"]` lists the class names actually present
    in this save, already sorted ascending by their live voxel index
    (MonaiLabelPanel.tsx's onClickSaveSegmentation) - zipping that against
    the save's own sorted distinct nonzero voxel values recovers the mapping
    exactly as it was at save time, with no dependency on any model config.
    """
    names = info.get("classes")
    if not names:
        raise ValueError(
            f"Saved label '{tag}' has no recorded class names - it may predate the save/load feature"
        )
    values = sorted(int(v) for v in np.unique(arr) if v != 0)
    if len(values) != len(names):
        raise ValueError(
            f"Saved label '{tag}' lists {len(names)} class name(s) {names} but has "
            f"{len(values)} distinct voxel value(s) {values} in the file - can't reliably match them up"
        )
    return dict(zip(values, names))


def score_region_by_segmentation(
    region_mask: np.ndarray,
    ct_arr: np.ndarray,
    ild_arr: np.ndarray,
    spacing_zyx,
    classes: Dict[int, str],
) -> Dict[str, Optional[float]]:
    """Interim region scorer: % of this region's lung voxels labeled as
    each ILD class in the saved ILD segmentation. `ct_arr` (the source
    image intensities) is accepted but unused here - a future scorer
    backed by an image-based model will need it, so the interface already
    carries it to avoid a signature change later.
    """
    del ct_arr  # unused by this interim, segmentation-based scorer

    total = int(region_mask.sum())
    if total == 0:
        result: Dict[str, Optional[float]] = {name: None for name in classes.values()}
        result["unclassified"] = None
        return result

    result = {}
    for class_index, name in classes.items():
        count = int(np.count_nonzero((ild_arr == class_index) & region_mask))
        result[name] = 100.0 * count / total
    unclassified_count = int(np.count_nonzero((ild_arr == 0) & region_mask))
    result["unclassified"] = 100.0 * unclassified_count / total
    return result


def compute_regional_stats(
    app,
    image: str,
    peripheral_distance_mm: float = 20.0,
    region_scorer: Callable = score_region_by_segmentation,
) -> Dict:
    datastore = app.datastore()

    lung_tag = _latest_tag_for_models(datastore, image, LUNG_MODELS)
    if not lung_tag:
        raise ValueError(
            "No saved lung segmentation found for this image - run and save an nnunet_lung result first"
        )
    ild_tag = _latest_tag_for_models(datastore, image, ILD_MODELS)
    if not ild_tag:
        raise ValueError(
            "No saved ILD segmentation found for this image - run and save an nnunet_ild or sam2_ild result first"
        )

    lung_info = datastore.get_label_info(image, lung_tag)
    ild_info = datastore.get_label_info(image, ild_tag)

    lung_ts, ild_ts = lung_info.get("ts"), ild_info.get("ts")
    stale_pairing_warning = (
        lung_ts is not None and ild_ts is not None and abs(lung_ts - ild_ts) > STALE_PAIRING_SECONDS
    )

    lung_img = _read_oriented(datastore, image, lung_tag)
    ild_img = _read_oriented(datastore, image, ild_tag)

    if (
        lung_img.GetSize() != ild_img.GetSize()
        or lung_img.GetSpacing() != ild_img.GetSpacing()
        or lung_img.GetOrigin() != ild_img.GetOrigin()
        or lung_img.GetDirection() != ild_img.GetDirection()
    ):
        raise ValueError(
            f"Lung save '{lung_tag}' and ILD save '{ild_tag}' have different geometry "
            f"(size {lung_img.GetSize()} vs {ild_img.GetSize()}, "
            f"spacing {lung_img.GetSpacing()} vs {ild_img.GetSpacing()}, "
            f"origin {lung_img.GetOrigin()} vs {ild_img.GetOrigin()}, "
            f"direction {lung_img.GetDirection()} vs {ild_img.GetDirection()}) - "
            "they must be saved from the same source image"
        )

    ct_img = sitk.ReadImage(datastore.get_image_uri(image))
    ct_orienter = sitk.DICOMOrientImageFilter()
    ct_orienter.SetDesiredCoordinateOrientation("LPS")
    ct_img = ct_orienter.Execute(ct_img)

    spacing_xyz = lung_img.GetSpacing()
    spacing_zyx = (spacing_xyz[2], spacing_xyz[1], spacing_xyz[0])
    voxel_volume_ml = (spacing_xyz[0] * spacing_xyz[1] * spacing_xyz[2]) / 1000.0

    lung_arr_raw = sitk.GetArrayFromImage(lung_img)  # (z, y, x) int
    ild_arr = sitk.GetArrayFromImage(ild_img).astype(np.int32)
    ct_arr = sitk.GetArrayFromImage(ct_img)

    if ct_arr.shape != lung_arr_raw.shape:
        raise ValueError(
            f"Source image and lung save '{lung_tag}' have different geometry "
            f"({ct_arr.shape} vs {lung_arr_raw.shape}) - the image may have been re-converted since saving"
        )

    if not lung_arr_raw.any():
        raise ValueError(f"Saved lung segmentation '{lung_tag}' is empty")

    lung_index_map = _class_index_map(lung_info, lung_arr_raw, lung_tag)
    lung_name_to_index = {name.lower(): index for index, name in lung_index_map.items()}
    lung_index = lung_name_to_index.get("lung")
    if lung_index is None:
        raise ValueError(
            f"Saved label '{lung_tag}' doesn't contain a 'lung' class "
            f"(found: {list(lung_index_map.values())})"
        )
    lung_arr = lung_arr_raw == lung_index  # (z, y, x) bool

    classes = _class_index_map(ild_info, ild_arr, ild_tag)

    # Left/right split at the lung mask's own bounding-box x-midpoint.
    # LPS orientation guarantees increasing x-index = more Left.
    xs = np.nonzero(lung_arr.any(axis=(0, 1)))[0]
    x_mid = (xs.min() + xs.max()) / 2.0
    x_idx = np.arange(lung_arr.shape[2])
    is_left_col = x_idx > x_mid
    side_masks = {
        "left": lung_arr & is_left_col[np.newaxis, np.newaxis, :],
        "right": lung_arr & ~is_left_col[np.newaxis, np.newaxis, :],
    }

    # Central/peripheral: distance (mm) to nearest non-lung voxel, computed
    # once on the combined mask (the mediastinal lung surface is a real
    # boundary to non-lung tissue and should count too).
    distance_mm = ndimage.distance_transform_edt(lung_arr, sampling=spacing_zyx)
    peripheral_mask = lung_arr & (distance_mm <= peripheral_distance_mm)
    central_mask = lung_arr & ~peripheral_mask
    depth_masks = {"central": central_mask, "peripheral": peripheral_mask}

    regions = []
    for side in SIDES:
        side_mask = side_masks[side]
        z_indices = np.nonzero(side_mask.any(axis=(1, 2)))[0]
        if len(z_indices) == 0:
            zone_masks = {zone: np.zeros_like(lung_arr) for zone in ZONES}
        else:
            z_min, z_max = int(z_indices.min()), int(z_indices.max())
            # LPS orientation guarantees increasing z-index = more Superior.
            bounds = np.linspace(z_min, z_max + 1, 4)
            z_idx = np.arange(lung_arr.shape[0])
            zone_masks = {
                "lower": side_mask & (z_idx < bounds[1])[:, np.newaxis, np.newaxis],
                "middle": side_mask
                & (z_idx >= bounds[1])[:, np.newaxis, np.newaxis]
                & (z_idx < bounds[2])[:, np.newaxis, np.newaxis],
                "upper": side_mask & (z_idx >= bounds[2])[:, np.newaxis, np.newaxis],
            }

        for zone in ZONES:
            for depth in DEPTHS:
                region_mask = zone_masks[zone] & depth_masks[depth]
                voxel_count = int(region_mask.sum())
                lung_volume_ml = voxel_count * voxel_volume_ml

                bbox_voxel = None
                if voxel_count > 0:
                    rz, ry, rx = np.nonzero(region_mask)
                    bbox_voxel = {
                        "z": [int(rz.min()), int(rz.max())],
                        "y": [int(ry.min()), int(ry.max())],
                        "x": [int(rx.min()), int(rx.max())],
                    }

                class_percent = region_scorer(region_mask, ct_arr, ild_arr, spacing_zyx, classes)

                regions.append(
                    {
                        "side": side,
                        "zone": zone,
                        "depth": depth,
                        "lung_volume_ml": lung_volume_ml,
                        "bbox_voxel": bbox_voxel,
                        "class_percent": class_percent,
                    }
                )

    return {
        "image": image,
        "lung_tag": lung_tag,
        "ild_tag": ild_tag,
        "lung_saved_at": _format_ts(lung_ts),
        "ild_saved_at": _format_ts(ild_ts),
        "stale_pairing_warning": stale_pairing_warning,
        "peripheral_distance_mm": peripheral_distance_mm,
        "classes": list(classes.values()),
        "regions": regions,
    }
