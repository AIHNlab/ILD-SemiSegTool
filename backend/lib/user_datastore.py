"""Per-user datastore whose saved segmentations don't depend on the image cache.

MONAI Label's index (datastore_v2.json) drops an image - and every label saved
for it, with their info (model, classes, ...) - whenever the image's cached
file is missing at startup. The cache is disposable (re-downloaded from
Orthanc on demand, left out of backups), so after a restore or a cache
clear-out every save would vanish from the Load list and Regional Stats.

Saves are therefore looked up from the files themselves:
labels/<tag>/<image id>.<ext>, with their info read from the NRRD header the
viewer writes (format/model/classes/saved_at - see MonaiLabelPanel
buildSegmentationFile), merged with whatever the index still knows.
"""

import glob
import json
import logging
import os
from typing import Any, Dict

from monailabel.datastore.dicom import DICOMWebDatastore

logger = logging.getLogger(__name__)


def nrrd_header_info(path: str) -> Dict[str, Any]:
    """Label info from the "key:=value" lines of a saved NRRD's header ({} if none)."""
    if not path.endswith(".nrrd"):
        return {}
    keys: Dict[str, str] = {}
    try:
        with open(path, "rb") as f:
            for raw in f:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not line:  # blank line = end of header, binary data follows
                    break
                if ":=" in line:
                    k, v = line.split(":=", 1)
                    keys[k.strip()] = v
                if f.tell() > 65536:  # a header is never this long - not one of ours
                    break
    except OSError:
        return {}

    info: Dict[str, Any] = {}
    if keys.get("model"):
        info["model"] = keys["model"]
    if keys.get("saved_at"):
        info["saved_at"] = keys["saved_at"]
    try:
        # [{name, index, color}] -> names sorted by voxel index, the same shape
        # the viewer sends as info.classes (what Regional Stats expects).
        classes = json.loads(keys.get("classes") or "null")
        if isinstance(classes, list):
            info["classes"] = [c["name"] for c in sorted(classes, key=lambda c: c["index"])]
    except (ValueError, KeyError, TypeError):
        pass
    return info


class UserDatastore(DICOMWebDatastore):
    def _label_files(self, image_id: str) -> Dict[str, str]:
        """{tag: file} for every label file saved for this image, from disk."""
        labels_dir = self._datastore.label_path(None)
        found = {}
        if os.path.isdir(labels_dir):
            for tag in os.listdir(labels_dir):
                files = glob.glob(os.path.join(glob.escape(os.path.join(labels_dir, tag)), glob.escape(image_id) + ".*"))
                if files:
                    found[tag] = os.path.realpath(files[0])
        return found

    def get_labels_by_image_id(self, image_id: str) -> Dict[str, str]:
        tags = dict(super().get_labels_by_image_id(image_id))
        tags.update({tag: image_id for tag in self._label_files(image_id)})
        return tags

    def get_label_uri(self, label_id: str, label_tag: str) -> str:
        return super().get_label_uri(label_id, label_tag) or self._label_files(label_id).get(label_tag, "")

    def get_label_info(self, label_id: str, label_tag: str) -> Dict[str, Any]:
        uri = self.get_label_uri(label_id, label_tag)
        info = nrrd_header_info(uri) if uri else {}
        if uri and "ts" not in info:
            info["ts"] = int(os.path.getmtime(uri))
        info.update(super().get_label_info(label_id, label_tag) or {})
        return info

    def remove_label(self, label_id, label_tag):
        uri = self.get_label_uri(label_id, label_tag)
        if super().get_label_uri(label_id, label_tag):
            super().remove_label(label_id, label_tag)
        elif uri and os.path.isfile(uri):
            os.remove(uri)  # only on disk - the index no longer knows it
        # The base class skips its index refresh after a delete when auto_reload
        # is on (always, for DICOMweb), leaving it to a file watcher that ignores
        # .nrrd saves - re-sync explicitly so the delete shows straight away.
        self.refresh()
