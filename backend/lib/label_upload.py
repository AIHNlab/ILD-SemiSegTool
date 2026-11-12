"""The light run-length labelmap format the viewer and the server exchange.

Uploads: the viewer sends a save in this form and the server writes the stored
.nrrd (rle_to_nrrd, used by UserDatastore.save_label). Downloads: AI results
are sent to the viewer in this form too (nrrd_to_rle, used by MyApp.infer when
the request asks for result_format "rle"), so the browser rebuilds the volume
with a few block fills instead of decompressing ~80 MB with a JavaScript
library and remapping it voxel by voxel. On the wire the gateway gzips it.

The viewer does as little as possible, so saving works on any browser,
including tablets and phones: it run-length encodes the labelmap (one pass,
no libraries) and, where the browser has it built in, gzips that. Everything
else happens here: finding which classes are present, and writing the
gzip-compressed NRRD (with the tool's metadata header) that Load, Download and
Regional Stats read - see UserDatastore.save_label.

Upload format (".ildrle", optionally gzipped as a whole):
    b"ILDRLE01" | uint32 n | n x uint32 run lengths | n x uint8 values  (little-endian)
Geometry and metadata come in the save params (label_info):
    geometry: {sizes, spacing, direction (9, row per axis), origin}
    classes:  [{name, index, color}] - every class in the viewer session; only
              those with voxels are kept
    model, saved_at, study_instance_uid, series_instance_uid
"""

import gzip
import json
import logging
import os
import tempfile
from typing import Any, Dict, Tuple

import numpy as np

logger = logging.getLogger(__name__)

RLE_EXT = ".ildrle"
MAGIC = b"ILDRLE01"
FORMAT = "ild-semiseg-1"  # marks a .nrrd saved by this tool; versions the header keys below


def decode_rle(raw: bytes, total: int) -> np.ndarray:
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    if raw[:8] != MAGIC:
        raise ValueError("not an ILD run-length labelmap")
    n = int(np.frombuffer(raw, "<u4", 1, 8)[0])
    if len(raw) != 12 + 5 * n:
        raise ValueError("truncated run-length labelmap")
    lengths = np.frombuffer(raw, "<u4", n, 12)
    values = np.frombuffer(raw, np.uint8, n, 12 + 4 * n)
    if int(lengths.sum(dtype=np.int64)) != total:
        raise ValueError(f"labelmap has {int(lengths.sum(dtype=np.int64))} voxels, the image has {total}")
    return np.repeat(values, lengths)


def encode_rle(flat: np.ndarray) -> bytes:
    """Run-length bytes (format above) of a flat uint8 labelmap."""
    flat = np.ascontiguousarray(flat, dtype=np.uint8).ravel()
    if flat.size == 0:
        return MAGIC + np.uint32(0).astype("<u4").tobytes()
    starts = np.concatenate(([0], np.flatnonzero(flat[1:] != flat[:-1]) + 1))
    lengths = np.diff(np.append(starts, flat.size)).astype("<u4")
    return MAGIC + np.uint32(len(starts)).astype("<u4").tobytes() + lengths.tobytes() + flat[starts].tobytes()


def nrrd_to_rle(path: str) -> str:
    """A run-length copy (.ildrle, next to it) of an AI result .nrrd, voxels in
    the file's own order - the same order the viewer used to read them in."""
    import nrrd

    data, _ = nrrd.read(path, index_order="F")
    out = os.path.splitext(path)[0] + RLE_EXT
    with open(out, "wb") as f:
        f.write(encode_rle(data.ravel(order="F")))
    return out


# Header keys of a saved .nrrd the viewer needs to load it (written by rle_to_nrrd).
SAVED_KEYS = ("format", "model", "classes", "study_instance_uid", "series_instance_uid", "saved_at")


def saved_label_rle(path: str) -> Tuple[bytes, Dict[str, Any]]:
    """A saved .nrrd as (run-length bytes, {sizes, keys}) - what the viewer's
    Load uses, so it rebuilds the volume with block fills instead of
    decompressing it in JavaScript (see lib/user_context.py)."""
    import nrrd

    data, header = nrrd.read(path, index_order="F")
    keys = {k: str(header[k]) for k in SAVED_KEYS if k in header}
    return encode_rle(data.ravel(order="F")), {"sizes": [int(s) for s in data.shape], "keys": keys}


def _vec(values):
    return "(" + ",".join(repr(float(v)) for v in values) + ")"


def rle_to_nrrd(path: str, info: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """(temporary .nrrd file, label info for the index) from an uploaded .ildrle."""
    geometry = info.get("geometry") or {}
    sizes = [int(s) for s in geometry["sizes"]]
    spacing = [float(s) for s in geometry["spacing"]]
    direction = [float(d) for d in geometry["direction"]]
    origin = [float(o) for o in geometry["origin"]]
    if len(sizes) != 3 or len(spacing) != 3 or len(direction) != 9 or len(origin) != 3:
        raise ValueError("bad geometry in save params")

    with open(path, "rb") as f:
        voxels = decode_rle(f.read(), int(np.prod(sizes)))

    present = {int(v) for v in np.unique(voxels) if v}
    classes = sorted(
        (c for c in info.get("classes") or [] if int(c.get("index", 0)) in present), key=lambda c: int(c["index"])
    )
    if not classes:
        raise ValueError("the segmentation is empty - nothing to save")

    keys = {
        "format": FORMAT,
        "model": info.get("model") or "",
        "classes": json.dumps(classes, separators=(",", ":")),
        "study_instance_uid": info.get("study_instance_uid") or "",
        "series_instance_uid": info.get("series_instance_uid") or "",
        "saved_at": info.get("saved_at") or "",
    }
    # Same layout the viewer used to write (SegmentationReader.writeNrrdData):
    # Cornerstone's LPS world space, each direction row scaled by its spacing.
    header = (
        "NRRD0005\n"
        "type: uint8\n"
        "dimension: 3\n"
        "space: left-posterior-superior\n"
        f"sizes: {' '.join(map(str, sizes))}\n"
        "space directions: "
        + " ".join(_vec(np.array(direction[a * 3 : a * 3 + 3]) * spacing[a]) for a in range(3))
        + "\n"
        f"space origin: {_vec(origin)}\n"
        "encoding: gzip\n"
        + "".join(f"{k}:={str(v).replace(chr(10), ' ')}\n" for k, v in keys.items())
        + "\n"
    )
    fd, out = tempfile.mkstemp(suffix=".nrrd")
    with os.fdopen(fd, "wb") as f:
        f.write(header.encode())
        f.write(gzip.compress(voxels.tobytes(), compresslevel=6))
    logger.info(f"Converted uploaded labelmap: {len(classes)} class(es), {os.path.getsize(out)} bytes stored")

    index_info = {
        "model": keys["model"],
        "classes": [c["name"] for c in classes],
        "saved_at": keys["saved_at"],
    }
    return out, index_info
