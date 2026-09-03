"""12-region (2 sides x 3 craniocaudal zones x 2 depths) volumetric ILD
statistics, computed by combining a saved whole-lung mask (nnunet_lung)
with a saved ILD-class mask (nnunet_ild / sam2_ild) for the same image.

Both masks are written by their infer tasks via
`seg.CopyInformation(sitk.ReadImage(source_image_path))` before
`sitk.WriteImage(...)` (see lib/infers/nnunet.py and
lib/infers/sam2_interactive.py), so a lung save and an ILD save for the
same source image always share identical spacing/origin/direction - no
registration step is needed here, just a geometry equality check.

The "% affected" figure is intentionally pluggable (see `region_scorer`
below): the interim implementation derives it by counting ILD-mask voxels
per region, but this is meant to be swapped later for a call to a
purpose-built model that predicts %-affected directly from the region's
image data, without touching the region-splitting logic (steps 1-7).
"""

import logging
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

    lung_img = _read_oriented(datastore, image, lung_tag)
    ild_img = _read_oriented(datastore, image, ild_tag)

    if lung_img.GetSize() != ild_img.GetSize() or lung_img.GetSpacing() != ild_img.GetSpacing():
        raise ValueError(
            f"Lung save '{lung_tag}' and ILD save '{ild_tag}' have different geometry "
            f"(size {lung_img.GetSize()} vs {ild_img.GetSize()}, "
            f"spacing {lung_img.GetSpacing()} vs {ild_img.GetSpacing()}) - "
            "they must be saved from the same source image"
        )

    ct_img = sitk.ReadImage(datastore.get_image_uri(image))
    ct_orienter = sitk.DICOMOrientImageFilter()
    ct_orienter.SetDesiredCoordinateOrientation("LPS")
    ct_img = ct_orienter.Execute(ct_img)

    spacing_xyz = lung_img.GetSpacing()
    spacing_zyx = (spacing_xyz[2], spacing_xyz[1], spacing_xyz[0])
    voxel_volume_ml = (spacing_xyz[0] * spacing_xyz[1] * spacing_xyz[2]) / 1000.0

    lung_arr = sitk.GetArrayFromImage(lung_img) > 0  # (z, y, x) bool
    ild_arr = sitk.GetArrayFromImage(ild_img).astype(np.int32)
    ct_arr = sitk.GetArrayFromImage(ct_img)

    if ct_arr.shape != lung_arr.shape:
        raise ValueError(
            f"Source image and lung save '{lung_tag}' have different geometry "
            f"({ct_arr.shape} vs {lung_arr.shape}) - the image may have been re-converted since saving"
        )

    if not lung_arr.any():
        raise ValueError(f"Saved lung segmentation '{lung_tag}' is empty")

    model_config = app.models.get(ild_info.get("model"))
    if model_config is None or not getattr(model_config, "labels", None):
        raise ValueError(f"Could not resolve ILD class labels for model '{ild_info.get('model')}'")
    classes: Dict[int, str] = {index: name for name, index in model_config.labels.items()}

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
        "peripheral_distance_mm": peripheral_distance_mm,
        "classes": list(classes.values()),
        "regions": regions,
    }
