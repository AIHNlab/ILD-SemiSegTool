"""Apply the body-bbox crop + isotropic resample from preprocessing/preprocess_test_ct.py
to a single datastore image, in place, on demand from the OHIF panel's
"Preprocess Volume" button.

datastore.get_image_uri() converts a DICOMWeb series to a cached *.nii.gz on
first access and returns that same local path on every later call (see
monailabel's DICOMWebDatastore.get_image_uri) - overwriting it here means
every later infer()/regional_stats() call for this image sees the
preprocessed volume too, without re-running this step.
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
    datastore = app.datastore()
    image_path = datastore.get_image_uri(image)

    original = sitk.ReadImage(image_path)
    preprocessed = preprocess_ct_image(original, target_spacing)
    sitk.WriteImage(preprocessed, image_path)

    return {
        "image": image,
        "path": image_path,
        "original_size": original.GetSize(),
        "original_spacing": original.GetSpacing(),
        "size": preprocessed.GetSize(),
        "spacing": preprocessed.GetSpacing(),
    }
