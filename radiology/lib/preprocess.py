"""Body-bbox crop + isotropic resample from preprocessing/preprocess_test_ct.py,
applied to a single datastore image.

nnU-Net's own full-volume inference (lib/infers/nnunet.py) applies this
transform to every case it runs (the nnunet_lung/nnunet_ild models were
trained on data prepared the same way - see the SNF preprocessing script's
history) and maps the result back onto the original image's grid via
map_result_to_original(), so segmentation "just works" without any separate
step. preprocess_image() below is a read-only preview for the OHIF panel's
"Preprocess Slices" button (see radiology/lib/regional_stats.py-style
endpoints in patch_monailabel_datastore.py) - it reports the size/spacing
this transform would produce without writing anything, so there's nothing
here that could make the datastore's cached image and the OHIF viewport
(which always shows the untouched original DICOM series) disagree.
"""

import os
import sys
from typing import Any, Dict

import SimpleITK as sitk

# preprocessing/ lives at the repo root, a sibling of this app's own
# directory (radiology/), not inside it - add the repo root to sys.path so
# it can be imported without duplicating its logic here.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from preprocessing.preprocess_test_ct import preprocess_ct_image  # noqa: E402


def preprocess_image(app, image: str, target_spacing=(1.0, 1.0, 1.0)) -> Dict[str, Any]:
    """Preview only - does not write anything. Inference applies this
    transform itself (see preprocess_for_inference/map_result_to_original)
    regardless of whether this was ever called."""
    datastore = app.datastore()
    image_path = datastore.get_image_uri(image)

    original = sitk.ReadImage(image_path)
    preprocessed = preprocess_ct_image(original, target_spacing)

    return {
        "image": image,
        "original_size": original.GetSize(),
        "original_spacing": original.GetSpacing(),
        "size": preprocessed.GetSize(),
        "spacing": preprocessed.GetSpacing(),
    }


def preprocess_for_inference(image_path: str, target_spacing=(1.0, 1.0, 1.0)):
    """Load the original image and return (preprocessed_img, original_img).

    preprocessed_img is resampled + body-bbox-cropped, but preprocess_ct_image
    keeps its origin/spacing/direction in the same physical space as the
    input (safe_crop's origin shift accounts for the crop) - so a result
    computed on it can be mapped back onto original_img's exact grid with
    map_result_to_original(), without tracking crop offsets by hand.
    """
    original = sitk.ReadImage(image_path)
    preprocessed = preprocess_ct_image(original, target_spacing)
    return preprocessed, original


def map_result_to_original(result_img: sitk.Image, original: sitk.Image) -> sitk.Image:
    """Resample a segmentation computed on preprocess_for_inference()'s output
    back onto the original image's grid (nearest-neighbor, to preserve label
    values - not linear/BSpline, which would blend label indices into
    meaningless intermediate values). SimpleITK's Resample aligns images by
    physical position using each one's own origin/spacing/direction, not raw
    array indices, so this single call undoes both the crop and the resample
    at once.
    """
    resampler = sitk.ResampleImageFilter()
    resampler.SetReferenceImage(original)
    resampler.SetInterpolator(sitk.sitkNearestNeighbor)
    return resampler.Execute(result_img)
