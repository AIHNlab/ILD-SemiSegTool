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


def merge_saved_labels(paths, top: int = -1) -> Tuple[bytes, Dict[str, Any]]:
    """Several saved .nrrd files of one image layered into one segmentation,
    as (run-length bytes, {sizes, keys}) like saved_label_rle.

    Layered by size, independent of the order given: the save labelling the
    most voxels goes underneath, smaller ones on top (each writes only its
    labelled voxels). So the broad mask (lung) ends up below the detail drawn
    inside it (ILD classes), and small structures (airways) on top. `top` (an
    index into paths) puts that save on top instead - the viewer's "Merged
    layers" switch; meta["top"] says which index ended up on top. Classes
    are matched by name across saves (each save numbers its classes its own
    way); each keeps its number where that's free, otherwise gets the next
    free one. The merged class list goes into keys["classes"], so the viewer
    remaps it by name like any loaded save.
    """
    import nrrd

    merged = None
    sizes = None
    classes: Dict[str, Dict[str, Any]] = {}  # name -> {name, index, color}
    used = set()
    models, saved_ats, series = [], [], ""
    loaded = []
    for path in paths:
        data, header = nrrd.read(path, index_order="F")
        flat = np.ascontiguousarray(data.ravel(order="F"), dtype=np.uint8)
        loaded.append((int(np.count_nonzero(flat)), len(loaded), data.shape, header, flat))
    loaded.sort(key=lambda item: -item[0])  # largest first = bottom layer
    if 0 <= top < len(loaded):
        loaded.sort(key=lambda item: item[1] == top)  # stable: just moves it last
    for _, _, shape, header, flat in loaded:
        if sizes is None:
            sizes = [int(s) for s in shape]
            merged = np.zeros(flat.size, np.uint8)
        elif [int(s) for s in shape] != sizes:
            raise ValueError(f"saves have different sizes ({sizes} vs {list(shape)}) - not from the same image")
        try:
            file_classes = json.loads(str(header.get("classes") or "[]"))
        except ValueError:
            file_classes = []
        if not isinstance(file_classes, list) or not file_classes:
            # No class list (not saved by this tool): keep its numbers as they are.
            file_classes = [{"name": f"label {int(v)}", "index": int(v)} for v in np.unique(flat) if v]
        lut = np.zeros(256, np.uint8)
        for c in file_classes:
            name, index = str(c["name"]), int(c["index"])
            if name not in classes:
                target = index if 0 < index < 256 and index not in used else next(i for i in range(1, 256) if i not in used)
                used.add(target)
                classes[name] = {"name": name, "index": target, **({"color": c["color"]} if "color" in c else {})}
            lut[index & 255] = classes[name]["index"]
        mapped = lut[flat]
        np.copyto(merged, mapped, where=mapped != 0)
        if header.get("model"):
            models.append(str(header["model"]))
        if header.get("saved_at"):
            saved_ats.append(str(header["saved_at"]))
        series = series or str(header.get("series_instance_uid") or "")

    present = set(np.unique(merged).tolist())
    keys = {
        "format": FORMAT,
        "model": " + ".join(dict.fromkeys(models)),
        "classes": json.dumps(
            sorted((c for c in classes.values() if c["index"] in present), key=lambda c: c["index"]),
            separators=(",", ":"),
        ),
        "series_instance_uid": series,
        "saved_at": max(saved_ats) if saved_ats else "",
    }
    return encode_rle(merged), {"sizes": sizes, "keys": keys, "top": loaded[-1][1] if loaded else -1}


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
