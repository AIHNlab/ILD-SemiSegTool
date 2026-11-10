"""
Compute total-lung and 12-region ILD-pattern distribution from a lung-masked
ILD prediction (e.g. combined_masked_predictions/case_<ID>.nii.gz), without
requiring a separate lung segmentation.

This is the fallback path for when no dedicated lung mask is available (i.e.
the user ran only the ILD model, not the lung model, in the app). When a
lung segmentation *has* been run and saved, prefer
`radiology/lib/regional_stats.py::compute_regional_stats`, which derives the
regions from a real trained lung segmentation and is more reliable for the
left/right split (see below) - this script exists to still produce a result
when that isn't available.

The 12 regions are Left/Right x Central/Peripheral x Upper/Middle/Lower,
matching the region taxonomy used elsewhere in this app and in the group's
prior work (Christe et al., "Computer-Aided Diagnosis of Pulmonary Fibrosis
Using Deep Learning and CT Images", Invest Radiol 2019): each lung is split
into thirds of equal *volume* (not equal physical extent) along the
craniocaudal axis, and into central/peripheral by distance to the nearest
non-lung voxel.

Left/right is derived directly from the ILD mask itself: the two lungs are
normally disjoint blobs (separated by the mediastinum), so 3D
connected-component labeling isolates them without needing another file
(verified on this dataset: the two largest components account for ~100% of
lung volume in 25/32 cases; everything else is sub-50-voxel segmentation
noise). A separate lung-mask file with laterality labels is deliberately NOT
used for this split: in this dataset the ILD prediction volumes have had
their spatial origin reset during nnU-Net preprocessing (likely from padding
to a common canvas size), so they no longer share a physical coordinate
frame with the original per-patient lung masks (LungMasks/,
LungMasks_Resampled/) -- resampling one onto the other's grid via their
NIfTI affines silently produces zero overlap. Deriving left/right from the
ILD mask's own geometry sidesteps that problem entirely.

If the two lungs are fused into a single connected component (e.g. severe
disease, or one lung surgically absent - in 7/32 cases here), the script
falls back to splitting that component at its median left-right coordinate;
this is reported in the output as lr_split_method so callers can gauge
reliability. This is the known failure mode of any geometry-only left/right
split (the 2019 paper above reports the same failure mode for its own
region-growing-based lung separation), and is the reason to prefer
regional_stats.py's lung-segmentation-based split whenever one is available.

Usage:
    python calculate_regional_ild_distribution.py
    python calculate_regional_ild_distribution.py --case P001
    python calculate_regional_ild_distribution.py --ild-dir ... --output-dir ...

Can also be imported and called directly (e.g. from an OHIF/MONAI backend),
for a single case, with no batch/CLI overhead:
    from calculate_regional_ild_distribution import compute_region_distribution
    result = compute_region_distribution(ild_path, case_id="P001")
"""

import argparse
import csv
import json
import os
import re

import nibabel as nib
import numpy as np
from scipy import ndimage

ILD_DIR_DEFAULT = "combined_masked_predictions"
OUTPUT_DIR_DEFAULT = "regional_ild_distribution"

LABELS = {
    0: "background",
    1: "healthy",
    2: "ground glass",
    3: "reticulation",
    4: "consolidation",
    5: "honeycombing",
    6: "ret + ggo",
    7: "bronchioectasis",
    8: "emphysema",
}

ZONES = ("upper", "middle", "lower")
DEPTHS = ("central", "peripheral")
DEFAULT_PERIPHERAL_DISTANCE_MM = 20.0

# Minimum fraction of total lung volume a connected component must have to be
# treated as a candidate lung (rather than segmentation noise).
MIN_COMPONENT_FRACTION = 0.01


def _label_breakdown(values, denom_region, denom_total_lung, voxel_ml):
    """Per-label voxel counts / volumes / percentages for one region's ILD values."""
    vals, counts = np.unique(values, return_counts=True)
    counts_by_label = dict(zip(vals.tolist(), counts.tolist()))
    breakdown = {}
    for lbl, name in LABELS.items():
        if lbl == 0:
            continue
        c = counts_by_label.get(lbl, 0)
        breakdown[name] = {
            "voxel_count": c,
            "volume_ml": round(c * voxel_ml, 3),
            "percent_of_region": round(100.0 * c / denom_region, 3) if denom_region else 0.0,
            "percent_of_total_lung": round(100.0 * c / denom_total_lung, 3) if denom_total_lung else 0.0,
        }
    return breakdown


def _split_left_right(lung_mask, physical_x):
    """Return (side_array, method) where side_array is 'right'/'left' per lung voxel.

    physical_x is the RAS X coordinate (mm) for each True voxel in lung_mask,
    in the same order as np.argwhere(lung_mask) / lung_mask's own boolean index
    order. NIfTI world space convention: +X = anatomical Right.
    """
    labeled, n_components = ndimage.label(lung_mask)
    if n_components == 0:
        return np.array([], dtype="<U5"), "none"

    sizes = ndimage.sum(lung_mask, labeled, index=range(1, n_components + 1))
    total = sizes.sum()
    order = np.argsort(sizes)[::-1]
    big_components = [i + 1 for i in order if sizes[i] / total >= MIN_COMPONENT_FRACTION][:2]

    labeled_at_voxels = labeled[lung_mask]

    if len(big_components) >= 2:
        c_a, c_b = big_components[0], big_components[1]
        mean_x_a = physical_x[labeled_at_voxels == c_a].mean()
        mean_x_b = physical_x[labeled_at_voxels == c_b].mean()
        threshold = (mean_x_a + mean_x_b) / 2.0
        method = "connected_components"
    else:
        threshold = np.median(physical_x)
        method = "median_x_fallback"

    side = np.where(physical_x > threshold, "right", "left")
    return side, method


def compute_region_distribution(ild_path, case_id=None, peripheral_distance_mm=DEFAULT_PERIPHERAL_DISTANCE_MM):
    """Return total-lung and 12-region ILD-pattern distribution for one case."""
    ild_img = nib.load(ild_path)
    ild_data = np.asarray(ild_img.dataobj).round().astype(np.int16)
    lung_mask = ild_data != 0

    zooms = ild_img.header.get_zooms()[:3]
    voxel_ml = float(np.prod(zooms)) / 1000.0
    total_voxels = int(lung_mask.sum())

    result = {
        "case_id": case_id or os.path.basename(ild_path),
        "voxel_volume_ml": round(voxel_ml, 6),
        "total_lung_volume_ml": round(total_voxels * voxel_ml, 3),
        "peripheral_distance_mm": peripheral_distance_mm,
        "total_distribution": {
            "percent_of_lung": _label_breakdown(ild_data[lung_mask], total_voxels, total_voxels, voxel_ml),
            "percent_of_full_volume": {
                name: round(100.0 * int((ild_data == lbl).sum()) / ild_data.size, 3)
                for lbl, name in LABELS.items()
            },
        },
        "lr_split_method": None,
        "regions": {},
    }

    empty_region = {
        "voxel_count": 0,
        "volume_ml": 0.0,
        "labels": _label_breakdown(np.array([], dtype=np.int16), 0, total_voxels, voxel_ml),
    }
    for side_name in ("right", "left"):
        for zone_name in ZONES:
            for depth_name in DEPTHS:
                result["regions"][f"{side_name}_{zone_name}_{depth_name}"] = dict(empty_region)

    if total_voxels == 0:
        result["lr_split_method"] = "none"
        return result

    # Distance (mm) to the nearest non-lung voxel, computed once on the whole
    # lung mask (both sides together) - the mediastinal surface is a real
    # boundary to non-lung tissue and should count toward "peripheral" too.
    distance_mm = ndimage.distance_transform_edt(lung_mask, sampling=zooms)
    depth_of_voxel_full = np.where(distance_mm[lung_mask] <= peripheral_distance_mm, "peripheral", "central")

    ijk = np.argwhere(lung_mask)
    affine = ild_img.affine
    physical = ijk @ affine[:3, :3].T + affine[:3, 3]
    x_coord, z_coord = physical[:, 0], physical[:, 2]  # RAS mm; +X = right, +Z = superior
    ild_of_voxel = ild_data[lung_mask]

    side_of_voxel, lr_split_method = _split_left_right(lung_mask, x_coord)
    result["lr_split_method"] = lr_split_method

    for side_name in ("right", "left"):
        side_sel = side_of_voxel == side_name
        if not np.any(side_sel):
            continue

        side_z = z_coord[side_sel]
        side_depth = depth_of_voxel_full[side_sel]
        side_ild = ild_of_voxel[side_sel]

        # Equal-volume craniocaudal thirds: quantiles of the z-coordinate
        # over all of this side's lung voxels, not thirds of the physical
        # z-range - a wider mid-lung slab should not dominate a range-based
        # split the way it would dominate a volume-based one.
        lower_bound, upper_bound = np.quantile(side_z, [1.0 / 3.0, 2.0 / 3.0])
        zone = np.where(side_z >= upper_bound, "upper", np.where(side_z >= lower_bound, "middle", "lower"))

        for zone_name in ZONES:
            for depth_name in DEPTHS:
                sel = (zone == zone_name) & (side_depth == depth_name)
                region_voxel_count = int(sel.sum())
                result["regions"][f"{side_name}_{zone_name}_{depth_name}"] = {
                    "voxel_count": region_voxel_count,
                    "volume_ml": round(region_voxel_count * voxel_ml, 3),
                    "labels": _label_breakdown(side_ild[sel], region_voxel_count, total_voxels, voxel_ml),
                }

    return result


def _write_case_csv_rows(writer, case_result):
    filename = case_result["case_id"]
    for name, stats in case_result["total_distribution"]["percent_of_lung"].items():
        writer.writerow([
            filename, "TOTAL", name, stats["voxel_count"], stats["volume_ml"],
            stats["percent_of_region"], stats["percent_of_total_lung"],
        ])
    for region_name, region in case_result["regions"].items():
        for name, stats in region["labels"].items():
            writer.writerow([
                filename, region_name, name, stats["voxel_count"], stats["volume_ml"],
                stats["percent_of_region"], stats["percent_of_total_lung"],
            ])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ild-dir", default=ILD_DIR_DEFAULT, help="Folder of case_<ID>.nii.gz lung-masked ILD predictions")
    parser.add_argument("--output-dir", default=OUTPUT_DIR_DEFAULT, help="Where to write per-case JSON and the aggregate CSV")
    parser.add_argument("--case", default=None, help="Process a single case ID (e.g. P001) instead of the whole folder")
    parser.add_argument("--peripheral-distance-mm", type=float, default=DEFAULT_PERIPHERAL_DISTANCE_MM,
                         help="Distance (mm) from the lung boundary defining the peripheral band")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    if args.case:
        case_ids = [args.case]
    else:
        case_ids = sorted(
            re.match(r"case_(.+)\.nii\.gz$", f).group(1)
            for f in os.listdir(args.ild_dir)
            if re.match(r"case_(.+)\.nii\.gz$", f)
        )

    csv_path = os.path.join(args.output_dir, "regional_ild_distribution.csv")
    with open(csv_path, "w", newline="") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(["Filename", "Region", "Label", "VoxelCount", "Volume_mL", "PercentOfRegion", "PercentOfTotalLung"])

        for case_id in case_ids:
            ild_path = os.path.join(args.ild_dir, f"case_{case_id}.nii.gz")
            if not os.path.exists(ild_path):
                print(f"skipping {case_id}: no ILD file at {ild_path}")
                continue

            print(f"processing {case_id}...")
            result = compute_region_distribution(ild_path, case_id=case_id, peripheral_distance_mm=args.peripheral_distance_mm)
            if result["lr_split_method"] == "median_x_fallback":
                print(f"  warning: {case_id} lungs were not cleanly separable; used median-X fallback for left/right split")

            with open(os.path.join(args.output_dir, f"{case_id}.json"), "w") as jf:
                json.dump(result, jf, indent=2)

            _write_case_csv_rows(writer, result)

    print(f"done. per-case JSON + aggregate CSV written to: {args.output_dir}")


if __name__ == "__main__":
    main()
