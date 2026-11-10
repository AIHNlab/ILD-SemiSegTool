import logging

import numpy as np
from PIL import Image as PILImage

logger = logging.getLogger(__name__)

HU_MIN = -1000
HU_MAX = 400


def normalize_ct(volume: np.ndarray) -> np.ndarray:
    volume = np.clip(volume, HU_MIN, HU_MAX).astype(np.float32)
    volume = (volume - HU_MIN) / (HU_MAX - HU_MIN)
    return (volume * 255).astype(np.uint8)


def bbox_mask(w: int, h: int, xmin: float, ymin: float, xmax: float, ymax: float) -> np.ndarray:
    mask = np.zeros((h, w), dtype=np.uint8)
    x0, x1 = sorted((int(round(xmin)), int(round(xmax))))
    y0, y1 = sorted((int(round(ymin)), int(round(ymax))))
    mask[max(y0, 0):min(y1 + 1, h), max(x0, 0):min(x1 + 1, w)] = 1
    return mask


def polygon_mask(vertices, w: int, h: int) -> np.ndarray:
    from PIL import ImageDraw

    img = PILImage.new("L", (w, h), 0)
    ImageDraw.Draw(img).polygon([(x, y) for x, y in vertices], outline=1, fill=1)
    return (np.array(img) > 0).astype(np.uint8)


EXCLUDE_POINT_RADIUS = 20


def exclude_region_mask(w: int, h: int, shapes) -> np.ndarray:
    """1 everywhere except inside any of the given exclude shapes, where
    it's 0 - AND this into an existing clip/result to carve those regions
    back out of a segmented result.

    `shapes`: list of dicts, one of:
      {"type": "point", "xy": [x, y]}          - small disk around a click
      {"type": "box", "start": [x, y], "end": [x, y]}
      {"type": "polygon", "points": [[x, y], ...]}

    This is the post-hoc equivalent of a negative/exclude prompt for a model
    that has no native way to take one as input at all (nnU-Net is a plain
    classifier - it doesn't consume prompts, so there's nothing to feed a
    negative region into). It's also applied as a guarantee on top of models
    that DO have a native negative-point mechanism (SAM2's own point
    prompting, for point-only runs), since that's a soft influence on the
    mask decoder, not a hard "never include this" rule the way this is.
    """
    remove = np.zeros((h, w), dtype=bool)
    yy, xx = np.mgrid[0:h, 0:w]
    for shape in shapes:
        kind = shape.get("type")
        if kind == "point":
            x, y = shape["xy"]
            remove |= (xx - x) ** 2 + (yy - y) ** 2 <= EXCLUDE_POINT_RADIUS**2
        elif kind == "box":
            remove |= bbox_mask(w, h, *shape["start"], *shape["end"]).astype(bool)
        elif kind == "polygon":
            remove |= polygon_mask(shape["points"], w, h).astype(bool)
    return (~remove).astype(np.uint8)


def convex_hull(points) -> np.ndarray:
    """Andrew's monotone chain. `points`: iterable of (x, y). Returns hull
    vertices (M, 2) in CCW order, or None if fewer than 3 distinct points or
    all points are collinear (no enclosed area to outline).

    A geometric enclosure of a point set that always fills its full interior
    (no gaps/scatter) - used both as the plain fallback outline for point
    prompts, and by point_outline() below to re-enclose the (possibly
    patchy) region random_walker actually found.
    """
    pts = sorted(set((float(x), float(y)) for x, y in points))
    if len(pts) < 3:
        return None

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    hull = lower[:-1] + upper[:-1]
    return np.array(hull, dtype=np.float32) if len(hull) >= 3 else None


POINT_PATCH_MARGIN = 40


def point_outline(img_slice: np.ndarray, points_xy, w: int, h: int) -> np.ndarray:
    """The outline for a point prompt: random_walker region growing from the
    clicked seeds (respects real tissue similarity, unlike a plain hull of
    the click points), then the convex hull of whichever pixels it actually
    grew into becomes the final outline - this re-encloses the walker's
    result into one smooth, fully-filled shape instead of using its raw
    output directly, which on noisy/heterogeneous textures (like ILD
    patterns) comes out scattered/patchy rather than one coherent region.

    Falls back to the plain hull of the click points themselves if the
    walker fails, finds nothing, or isn't connected to any seed.
    """
    from skimage.segmentation import random_walker
    from scipy import ndimage

    fallback = convex_hull(points_xy)

    xs = [p[0] for p in points_xy]
    ys = [p[1] for p in points_xy]
    x0 = max(0, int(min(xs)) - POINT_PATCH_MARGIN)
    x1 = min(w - 1, int(max(xs)) + POINT_PATCH_MARGIN)
    y0 = max(0, int(min(ys)) - POINT_PATCH_MARGIN)
    y1 = min(h - 1, int(max(ys)) + POINT_PATCH_MARGIN)

    # float32, not float64 - halves the memory/work random_walker's linear
    # solve does per patch, with no meaningful precision loss for an 8-bit
    # normalized CT patch
    patch = img_slice[y0 : y1 + 1, x0 : x1 + 1].astype(np.float32)
    labels = np.zeros(patch.shape, dtype=np.uint8)
    labels[0, :] = labels[-1, :] = labels[:, 0] = labels[:, -1] = 2
    seed_local = []
    for x, y in points_xy:
        ly, lx = int(round(y)) - y0, int(round(x)) - x0
        labels[max(0, ly - 1) : ly + 2, max(0, lx - 1) : lx + 2] = 1
        seed_local.append((ly, lx))

    try:
        grown = random_walker(patch, labels, beta=130, mode="cg_j") == 1
    except Exception:
        logger.exception("point-seeded region growing failed, falling back to the click points' own hull")
        return fallback

    if not grown.any():
        return fallback

    # keep only the component(s) actually touching a seed point - drops any
    # small disconnected noise elsewhere in the patch before it can drag the
    # hull out to somewhere the user never clicked
    labeled, _ = ndimage.label(grown)
    seed_components = {labeled[ly, lx] for ly, lx in seed_local if 0 <= ly < labeled.shape[0] and 0 <= lx < labeled.shape[1]}
    seed_components.discard(0)
    keep = np.isin(labeled, list(seed_components)) if seed_components else grown

    ys_idx, xs_idx = np.where(keep)
    if len(xs_idx) < 3:
        return fallback

    grown_points = list(zip((xs_idx + x0).tolist(), (ys_idx + y0).tolist()))
    hull = convex_hull(grown_points)
    return hull if hull is not None else fallback
