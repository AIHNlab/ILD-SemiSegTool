import logging
import tempfile
import threading

import numpy as np
from PIL import Image as PILImage

from monailabel.interfaces.tasks.infer_v2 import InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask
from lib.infers.prompt_utils import normalize_ct, bbox_mask, polygon_mask, point_outline, exclude_region_mask

logger = logging.getLogger(__name__)

SAM2_SIZE = 512
SAM2_CFG = "configs/sam2.1_hiera_t512.yaml"

# MedSAM2 is trained (NormalizeAPI in its training configs) and run
# (medsam2_infer_3D_CT.py) on ImageNet-normalized frames - the predictor
# doesn't apply this itself, so feeding raw [0, 1] frames is off-distribution.
IMG_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
IMG_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]

# Slices to track forward/backward from the prompted slice. Left unbounded,
# propagate_in_video tracks across the whole volume by default, which lets
# the tracker drift onto unrelated small blobs far from where the user drew
# (and wastes time processing hundreds of irrelevant slices). 60 covers most
# real lesion extents while still bounding runaway drift across the volume -
# raise further if findings still get cut off at the window edge.
MAX_FRAMES_TO_TRACK = 60


def _resize_to_rgb(imgs: np.ndarray, size: int = SAM2_SIZE) -> np.ndarray:
    """(D, H, W) uint8 -> (D, 3, size, size) float32, ImageNet-normalized."""
    d = imgs.shape[0]
    out = np.zeros((d, 3, size, size), dtype=np.float32)
    for z in range(d):
        img = PILImage.fromarray(imgs[z]).resize((size, size), PILImage.BILINEAR)
        arr = np.array(img, dtype=np.float32) / 255.0
        out[z] = (np.stack([arr, arr, arr], axis=0) - IMG_MEAN) / IMG_STD
    return out


def _collect_masks(out_mask_logits, h: int, w: int) -> np.ndarray:
    combined = np.zeros((h, w), dtype=np.uint8)
    for obj_mask in out_mask_logits:
        mask = (obj_mask > 0).cpu().numpy().squeeze()
        if mask.ndim == 0:
            continue
        m = PILImage.fromarray(mask.astype(np.uint8) * 255).resize((w, h), PILImage.NEAREST)
        combined = np.maximum(combined, (np.array(m) > 127).astype(np.uint8))
    return combined


def _scale_xy(x: float, y: float, w: int, h: int) -> tuple:
    return x * SAM2_SIZE / w, y * SAM2_SIZE / h


MAX_PROMPT_POINTS = 40

# Padding around a brush-drawn mask's own bounding box before clipping the
# propagated result to it - the mask is already pixel-exact (unlike a point
# click), so this only needs to be big enough to let SAM2 refine/shift
# slightly slice to slice, not to grow an outline the way POINT_PATCH_MARGIN
# does in prompt_utils.py.
BRUSH_PATCH_MARGIN = 24


def _polygon_interior_points(vertices, w: int, h: int, max_points: int = MAX_PROMPT_POINTS) -> np.ndarray:
    """Freehand ROI vertices (index-space, on one slice) -> point prompts sampled
    from inside the drawn polygon, fed to add_new_points_or_box (not a mask prompt
    via add_new_mask - point prompts are what this model was validated against)."""
    from PIL import ImageDraw

    scaled = [_scale_xy(x, y, w, h) for x, y in vertices]
    mask_img = PILImage.new("L", (SAM2_SIZE, SAM2_SIZE), 0)
    ImageDraw.Draw(mask_img).polygon(scaled, outline=1, fill=1)
    ys, xs = np.where(np.array(mask_img) > 0)
    pts = np.stack([xs, ys], axis=1).astype(np.float32)
    if len(pts) > max_points:
        idx = np.random.choice(len(pts), max_points, replace=False)
        pts = pts[idx]
    return pts


class SAM2InteractiveInferTask(BasicInferTask):
    """
    Interactive 3D segmentation using a fine-tuned SAM2 model.

    Accepts one of three prompt types drawn by the user in OHIF on a single
    "key" slice, then propagates the resulting mask forward and backward
    through the volume:
      - foreground/background click points
      - a rectangle ROI (start/end corners, same shape nnU-Net's ROI crop uses)
      - a freehand polygon (sampled into interior point prompts)

    SAM2 only ever produces one binary object mask per run - it has no notion
    of which of the 8 ILD patterns that region is, so the request's "label"
    field picks which one this run's mask gets written as (defaults to
    "healthy" if omitted). For multi-class output that classifies the
    prompted region into all 8 patterns at once, see NNUNet instead
    (lib/infers/nnunet.py) - the Semi-Segmentation panel lets the user pick
    either model directly.
    """

    def __init__(self, checkpoint_path: str, labels, label_colors=None, description: str = ""):
        super().__init__(
            path=checkpoint_path,
            network=None,
            type=InferType.DEEPGROW,
            labels=labels,
            dimension=3,
            description=description or "SAM2 interactive segmentation",
        )
        self._checkpoint_path = checkpoint_path
        self._label_colors = label_colors or {}
        self._predictor = None
        self._lock = threading.Lock()

    def is_valid(self) -> bool:
        return True

    def pre_transforms(self, data=None):
        return []

    def post_transforms(self, data=None):
        return []

    def _get_predictor(self, device: str):
        if self._predictor is None:
            with self._lock:
                if self._predictor is None:
                    import torch

                    import sam2  # noqa: F401  (triggers Hydra config-module registration)
                    from sam2.build_sam import build_sam2_video_predictor_npz

                    logger.info(f"Loading SAM2 checkpoint: {self._checkpoint_path}")
                    self._predictor = build_sam2_video_predictor_npz(
                        SAM2_CFG,
                        self._checkpoint_path,
                        device=torch.device(device),
                    )
        return self._predictor

    def _propagate(self, predictor, imgs_tensor, key_slice, add_prompt, d, h, w):
        pred_masks = np.zeros((d, h, w), dtype=np.uint8)

        for reverse in (False, True):
            state = predictor.init_state(imgs_tensor, video_height=SAM2_SIZE, video_width=SAM2_SIZE)
            add_prompt(predictor, state, key_slice)
            for fi, _, logits in predictor.propagate_in_video(
                state,
                start_frame_idx=key_slice,
                max_frame_num_to_track=MAX_FRAMES_TO_TRACK,
                reverse=reverse,
            ):
                pred_masks[fi] = _collect_masks(logits, h, w)
            predictor.reset_state(state)

        return pred_masks

    def _propagate_multi(self, predictor, imgs_tensor, frame_masks, d, h, w):
        """Same idea as _propagate, but for several already-known mask prompts at
        once (one brush stroke can touch many slices) - added to the SAME tracking
        pass instead of running one full propagate_in_video per slice. Frames in
        [lo, hi] all carry their own exact prompt mask already; only the two ends
        need the usual MAX_FRAMES_TO_TRACK of extra tracking beyond the touched
        range. frame_masks: list of (frame_idx, mask_2d) pairs."""
        pred_masks = np.zeros((d, h, w), dtype=np.uint8)
        lo = min(fi for fi, _ in frame_masks)
        hi = max(fi for fi, _ in frame_masks)
        max_frame_num_to_track = (hi - lo) + MAX_FRAMES_TO_TRACK

        for reverse in (False, True):
            state = predictor.init_state(imgs_tensor, video_height=SAM2_SIZE, video_width=SAM2_SIZE)
            for frame_idx, mask in frame_masks:
                predictor.add_new_mask(inference_state=state, frame_idx=frame_idx, obj_id=1, mask=mask)
            for fi, _, logits in predictor.propagate_in_video(
                state,
                start_frame_idx=hi if reverse else lo,
                max_frame_num_to_track=max_frame_num_to_track,
                reverse=reverse,
            ):
                pred_masks[fi] = _collect_masks(logits, h, w)
            predictor.reset_state(state)

        return pred_masks

    def __call__(self, request, callbacks=None):
        import SimpleITK as sitk
        import torch

        image_path = request.get("image")
        device = request.get("device", "cuda")
        foreground = request.get("foreground", [])  # [[x, y, z], ...]
        background = request.get("background", [])  # [[x, y, z], ...]
        roi = request.get("roi")  # {"start": [xmin, ymin, z], "end": [xmax, ymax, z]}
        mask_polygon = request.get("mask_polygon")  # [[x, y], ...]
        # [{"roi_slice": int, "brush_mask": [[x, y], ...]}, ...] - one entry per
        # slice touched by a single brush stroke/session, all propagated together
        # (see _propagate_multi) rather than one request per slice.
        brush_masks = request.get("brush_masks")
        roi_slice = request.get("roi_slice")
        exclude_shapes = request.get("exclude_shapes")  # [{"type": "point"|"box"|"polygon", ...}, ...]
        label_value = self.labels.get(request.get("label"), 1)

        sitk_img = sitk.ReadImage(image_path)
        img_np = sitk.GetArrayFromImage(sitk_img).astype(np.float32)  # (D, H, W)
        d, h, w = img_np.shape

        imgs_rgb = _resize_to_rgb(normalize_ct(img_np))
        imgs_tensor = torch.from_numpy(imgs_rgb).float()

        predictor = self._get_predictor(device)
        pred_masks = np.zeros((d, h, w), dtype=np.uint8)

        with torch.inference_mode():
            if brush_masks:
                # The brush tool edits the segmentation labelmap directly on
                # whichever slice(s) the user painted/erased on - these are
                # that edit's pixel-exact deltas (see SemiSegmentation.tsx's
                # buildBrushParamsList), fed to SAM2 as genuine mask prompts
                # (add_new_mask) instead of being approximated as points/box
                # like the other prompt types have to be.
                frame_masks = []
                for entry in brush_masks:
                    mask_2d = np.zeros((h, w), dtype=np.uint8)
                    for x, y in entry["brush_mask"]:
                        xi, yi = int(round(x)), int(round(y))
                        if 0 <= yi < h and 0 <= xi < w:
                            mask_2d[yi, xi] = 1
                    mask_scaled = (
                        np.array(
                            PILImage.fromarray(mask_2d * 255).resize((SAM2_SIZE, SAM2_SIZE), PILImage.NEAREST)
                        )
                        > 127
                    )
                    frame_masks.append((int(entry["roi_slice"]), mask_scaled))

                pred_masks = self._propagate_multi(predictor, imgs_tensor, frame_masks, d, h, w)

            elif mask_polygon:
                key_slice = int(roi_slice)
                pts = _polygon_interior_points(mask_polygon, w, h)
                lbs = np.ones(len(pts), dtype=np.int32)

                def add_prompt(predictor, state, frame_idx):
                    predictor.add_new_points_or_box(
                        inference_state=state, frame_idx=frame_idx, obj_id=1, points=pts, labels=lbs
                    )

                pred_masks = self._propagate(predictor, imgs_tensor, key_slice, add_prompt, d, h, w)

            elif roi:
                xmin, ymin, z = roi["start"]
                xmax, ymax, _ = roi["end"]
                key_slice = int(z)
                x0, y0 = _scale_xy(xmin, ymin, w, h)
                x1, y1 = _scale_xy(xmax, ymax, w, h)
                box_scaled = np.array([x0, y0, x1, y1], dtype=np.float32)

                def add_prompt(predictor, state, frame_idx):
                    predictor.add_new_points_or_box(
                        inference_state=state, frame_idx=frame_idx, obj_id=1, box=box_scaled
                    )

                pred_masks = self._propagate(predictor, imgs_tensor, key_slice, add_prompt, d, h, w)

            elif foreground:
                # OHIF sends clicks as [x, y, z] where x=column, y=row, z=slice index
                fg = np.array(foreground)
                key_slice = int(fg[0, 2])
                pts = np.array([_scale_xy(c[0], c[1], w, h) for c in fg], dtype=np.float32)
                lbs = np.ones(len(pts), dtype=np.int32)

                if background:
                    bg = np.array(background)
                    bg_pts = np.array([_scale_xy(c[0], c[1], w, h) for c in bg], dtype=np.float32)
                    pts = np.vstack([pts, bg_pts])
                    lbs = np.concatenate([lbs, np.zeros(len(bg_pts), dtype=np.int32)])

                def add_prompt(predictor, state, frame_idx):
                    predictor.add_new_points_or_box(
                        inference_state=state, frame_idx=frame_idx, obj_id=1, points=pts, labels=lbs
                    )

                pred_masks = self._propagate(predictor, imgs_tensor, key_slice, add_prompt, d, h, w)

            else:
                logger.warning(
                    "SAM2 inference called with no prompt (foreground/roi/mask_polygon/brush_masks)"
                )

        # roi/freehand prompts draw an explicit region - the user is telling the
        # model "look only here". SAM2's mask decoder isn't actually constrained
        # to that region (video tracking especially can drift), so clip anything
        # it finds outside the drawn bounds, on every tracked slice.
        if brush_masks:
            # The mask(s) are already pixel-exact - clip to the union of their
            # bounding boxes plus a small margin so propagation/refinement on
            # other slices can't drift far from where it was actually drawn.
            xs = [x for entry in brush_masks for x, _ in entry["brush_mask"]]
            ys = [y for entry in brush_masks for _, y in entry["brush_mask"]]
            clip = bbox_mask(
                w,
                h,
                min(xs) - BRUSH_PATCH_MARGIN,
                min(ys) - BRUSH_PATCH_MARGIN,
                max(xs) + BRUSH_PATCH_MARGIN,
                max(ys) + BRUSH_PATCH_MARGIN,
            )
            pred_masks *= clip[None, :, :]
        elif roi:
            xmin, ymin, _ = roi["start"]
            xmax, ymax, _ = roi["end"]
            clip = bbox_mask(w, h, xmin, ymin, xmax, ymax)
            pred_masks *= clip[None, :, :]
        elif mask_polygon:
            clip = polygon_mask(mask_polygon, w, h)
            pred_masks *= clip[None, :, :]
        elif foreground:
            # Points don't draw a region at all, so SAM2's own point-prompt
            # mask has nothing explicit to be bounded by - same idea as
            # nnU-Net's point path (lib/infers/nnunet.py): grow a real,
            # edge-aware region from the clicks (random_walker) and take its
            # hull as the outline, then clip SAM2's mask to it. Keeps SAM2's
            # own object tracing but stops it drifting/scattering outside
            # where the clicks actually indicated.
            fg = np.array(foreground)
            img_slice = normalize_ct(img_np[key_slice])
            hull = point_outline(img_slice, fg[:, :2].tolist(), w, h)
            if hull is not None:
                clip = polygon_mask(hull.tolist(), w, h)
                pred_masks *= clip[None, :, :]

        if exclude_shapes:
            # background points already steer SAM2's own point-prompt mask
            # (add_new_points_or_box above, for the foreground path only -
            # SAM2 can't take negative points alongside a box/polygon
            # prompt), but that's a soft influence on the mask decoder, not
            # a hard guarantee. This carves the exclude region(s) out
            # unconditionally, for every prompt type, the same way nnU-Net's
            # exclude handling does.
            clip = exclude_region_mask(w, h, exclude_shapes)
            pred_masks *= clip[None, :, :]

        if label_value != 1:
            pred_masks = pred_masks * label_value

        ext = request.get("result_extension", ".nrrd")
        if not ext.startswith("."):
            ext = "." + ext
        output_file = tempfile.NamedTemporaryFile(suffix=ext, delete=False).name
        # keep uint8 - the OHIF client reads the NRRD payload as a Uint8Array unconditionally
        pred_sitk = sitk.GetImageFromArray(pred_masks)
        pred_sitk.CopyInformation(sitk_img)
        sitk.WriteImage(pred_sitk, output_file)

        return output_file, {
            "label_names": self.labels,
            "label_colors": self._label_colors,
        }
