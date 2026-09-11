import argparse
import os
import numpy as np
import SimpleITK as sitk
from tqdm import tqdm
from scipy.ndimage import label


def trim_air(ct, air_threshold=-950, min_fraction=0.8):
    """
    Remove slices/rows/cols that are almost entirely air.
    VERY SAFE trimming.
    """

    def find_bounds(axis):
        proj = np.mean(ct < air_threshold, axis=axis)
        valid = proj < min_fraction

        if not np.any(valid):
            return 0, ct.shape[axis[0]]

        idx = np.where(valid)[0]
        return idx[0], idx[-1]

    # axes:
    # z: (1,2)
    # y: (0,2)
    # x: (0,1)

    zmin, zmax = find_bounds((1,2))
    ymin, ymax = find_bounds((0,2))
    xmin, xmax = find_bounds((0,1))

    return ct[zmin:zmax+1, ymin:ymax+1, xmin:xmax+1], zmin, ymin, xmin

# =========================
# FAST + ROBUST LUNG BBOX
# =========================
def get_body_bbox(ct):

    body_mask = ct > -500

    labeled, num = label(body_mask)

    if num == 0:
        return 0, ct.shape[0], 0, ct.shape[1], 0, ct.shape[2]

    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0

    body_id = np.argmax(sizes)
    body_mask = labeled == body_id

    coords = np.where(body_mask)

    zmin, zmax = coords[0].min(), coords[0].max()
    ymin, ymax = coords[1].min(), coords[1].max()
    xmin, xmax = coords[2].min(), coords[2].max()

    return zmin, zmax, ymin, ymax, xmin, xmax


# =========================
# SAFE CROP
# =========================
def safe_crop(ct, spacing=(1.0,1.0,1.0)):

    zmin, zmax, ymin, ymax, xmin, xmax = get_body_bbox(ct)

    # margins in mm → convert to voxels
    z_margin = int(10 / spacing[2])
    xy_margin = int(12 / spacing[1])

    zmin = max(0, zmin - z_margin)
    zmax = min(ct.shape[0], zmax + z_margin)

    ymin = max(0, ymin - xy_margin)
    ymax = min(ct.shape[1], ymax + xy_margin)

    xmin = max(0, xmin - xy_margin)
    xmax = min(ct.shape[2], xmax + xy_margin)

    cropped = ct[zmin:zmax, ymin:ymax, xmin:xmax]

    # controlled trimming
    cropped2, dz, dy, dx = trim_air(
        cropped,
        air_threshold=-900,
        min_fraction=0.80  
    )

    return cropped2, zmin + dz, ymin + dy, xmin + dx


# =========================
# RESAMPLING
# =========================
def resample_to_spacing(img, new_spacing=(1.0, 1.0, 1.0)):

    original_spacing = np.array(img.GetSpacing())
    original_size = np.array(img.GetSize())

    new_spacing = np.array(new_spacing)
    new_size = np.round(original_size * (original_spacing / new_spacing)).astype(int)

    resampler = sitk.ResampleImageFilter()
    resampler.SetOutputSpacing(new_spacing.tolist())
    resampler.SetSize([int(s) for s in new_size])
    resampler.SetOutputDirection(img.GetDirection())
    resampler.SetOutputOrigin(img.GetOrigin())
    resampler.SetInterpolator(sitk.sitkLinear)

    return resampler.Execute(img)


# =========================
# SINGLE-VOLUME PIPELINE
# =========================
def preprocess_ct_image(img: sitk.Image, target_spacing=(1.0, 1.0, 1.0)) -> sitk.Image:
    """Resample to isotropic spacing, then crop to the body bounding box.

    Shared by the batch CLI below and by radiology/lib/preprocess.py (which
    applies this to a single datastore image on demand from the OHIF panel).
    """
    img = resample_to_spacing(img, target_spacing)
    ct = sitk.GetArrayFromImage(img)
    cropped, zmin, ymin, xmin = safe_crop(ct)

    out = sitk.GetImageFromArray(cropped.astype(np.int16))
    out.SetSpacing(img.GetSpacing())
    out.SetDirection(img.GetDirection())

    # The crop's new (0,0,0) voxel is (xmin, ymin, zmin) in img's own index
    # space (x,y,z) - TransformIndexToPhysicalPoint correctly folds in
    # direction as well as spacing/origin to get its true physical
    # location. A plain `origin + index * spacing` (this file's previous
    # approach) is only correct when direction is the identity matrix; a
    # DICOM-derived NIfTI commonly has a non-identity direction (LPS/RAS
    # sign flips), which silently shifted the cropped volume's origin to
    # the wrong physical location - harmless for a human eyeballing the
    # cropped file directly, but it broke resampling a result computed on
    # this crop back onto the original image (radiology/lib/preprocess.py's
    # map_result_to_original), which depends on this origin being exactly
    # right.
    out.SetOrigin(img.TransformIndexToPhysicalPoint((int(xmin), int(ymin), int(zmin))))

    return out


# =========================
# MAIN LOOP (batch CLI)
# =========================
def main():
    parser = argparse.ArgumentParser(
        description="Crop CT volumes to the body bounding box and resample to isotropic spacing."
    )
    parser.add_argument("--input_dir", required=True, help="Directory containing input *.nii.gz CT volumes")
    parser.add_argument("--output_dir", required=True, help="Directory to write cropped *.nii.gz CT volumes")
    args = parser.parse_args()

    input_dir = args.input_dir
    output_dir = args.output_dir

    os.makedirs(output_dir, exist_ok=True)

    print("🚀 Starting cropping...")

    files = sorted([f for f in os.listdir(input_dir) if f.endswith(".nii.gz")])

    for f in tqdm(files):

        in_path = os.path.join(input_dir, f)
        out_path = os.path.join(output_dir, f)

        # skip existing (remove this if you want overwrite)
        if os.path.exists(out_path):
            continue

        try:
            img = sitk.ReadImage(in_path)
            out = preprocess_ct_image(img)
            sitk.WriteImage(out, out_path)
        except Exception as e:
            print(f"❌ Failed {f}: {e}")

    print("✅ Cropping DONE")


if __name__ == "__main__":
    main()