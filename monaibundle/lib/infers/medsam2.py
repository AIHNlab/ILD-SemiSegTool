import logging
import sys
import tempfile
import threading

import numpy as np
import torch
from PIL import Image as PILImage

from monailabel.interfaces.tasks.infer_v2 import InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask

# Ensure the sam2 package (and its Hydra config registration) is importable
_MICCAI_DIR = "/home/bill/MICCAI/MedSAM2"
if _MICCAI_DIR not in sys.path:
    sys.path.insert(0, _MICCAI_DIR)

logger = logging.getLogger(__name__)

HU_MIN = -1000
HU_MAX = 400
SAM2_SIZE = 512
# Inference config — same one used by infer_ild_npz.py / infer_lung_npz.py
SAM2_CFG = "configs/sam2.1_hiera_t512.yaml"
# MedSAM2 is trained and run on ImageNet-normalized frames; the predictor
# doesn't apply this itself.
IMG_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
IMG_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]


def _normalize_ct(volume: np.ndarray) -> np.ndarray:
    volume = np.clip(volume, HU_MIN, HU_MAX).astype(np.float32)
    volume = (volume - HU_MIN) / (HU_MAX - HU_MIN)
    return (volume * 255).astype(np.uint8)


def _resize_to_rgb(imgs: np.ndarray, size: int = SAM2_SIZE) -> np.ndarray:
    """(D, H, W) uint8 → (D, 3, size, size) float32, ImageNet-normalized."""
    D = imgs.shape[0]
    out = np.zeros((D, 3, size, size), dtype=np.float32)
    for z in range(D):
        img = PILImage.fromarray(imgs[z]).resize((size, size), PILImage.BILINEAR)
        arr = np.array(img, dtype=np.float32) / 255.0
        out[z] = (np.stack([arr, arr, arr], axis=0) - IMG_MEAN) / IMG_STD
    return out


def _collect_masks(out_mask_logits, H: int, W: int) -> np.ndarray:
    combined = np.zeros((H, W), dtype=np.uint8)
    for obj_mask in out_mask_logits:
        mask = (obj_mask > 0).cpu().numpy().squeeze()
        if mask.ndim == 0:
            continue
        m = PILImage.fromarray(mask.astype(np.uint8) * 255).resize((W, H), PILImage.NEAREST)
        combined = np.maximum(combined, (np.array(m) > 127).astype(np.uint8))
    return combined


class MedSAM2InferTask(BasicInferTask):
    """
    Interactive 3D segmentation using a fine-tuned MedSAM2 model.

    The user provides foreground (and optionally background) click points
    in OHIF. The z-coordinate of the first foreground click selects the key
    slice; SAM2 then propagates the segmentation forward and backward through
    the volume.
    """

    def __init__(self, checkpoint_path: str, model_name: str, labels, description: str):
        super().__init__(
            path=checkpoint_path,
            network=None,
            type=InferType.DEEPGROW,
            labels=labels,
            dimension=3,
            description=description,
        )
        self._checkpoint_path = checkpoint_path
        self._predictor = None
        self._lock = threading.Lock()

    # ── BasicInferTask abstract requirements ──────────────────────────────────

    def pre_transforms(self, data=None):
        return []

    def post_transforms(self, data=None):
        return []

    # ── Lazy predictor loading ────────────────────────────────────────────────

    def _get_predictor(self, device: str):
        if self._predictor is None:
            with self._lock:
                if self._predictor is None:
                    import sam2  # triggers Hydra config-module initialization
                    from sam2.build_sam import build_sam2_video_predictor_npz

                    logger.info(f"Loading MedSAM2 checkpoint: {self._checkpoint_path}")
                    self._predictor = build_sam2_video_predictor_npz(
                        SAM2_CFG,
                        self._checkpoint_path,
                        device=torch.device(device),
                    )
        return self._predictor

    # ── Main inference entry point ────────────────────────────────────────────

    def __call__(self, request, callbacks=None):
        import SimpleITK as sitk

        image_path = request.get("image")
        device = request.get("device", "cuda")
        foreground = request.get("foreground", [])  # [[z, y, x], ...]
        background = request.get("background", [])  # [[z, y, x], ...]

        logger.info(
            f"MedSAM2 inference: image={image_path}, "
            f"foreground={len(foreground)}, background={len(background)}"
        )

        # ── Load image via SimpleITK (returns HU in D×H×W order) ─────────────
        sitk_img = sitk.ReadImage(image_path)
        img_np = sitk.GetArrayFromImage(sitk_img).astype(np.float32)  # (D, H, W)
        D, H, W = img_np.shape

        # ── MedSAM2 preprocessing ─────────────────────────────────────────────
        img_uint8 = _normalize_ct(img_np)
        imgs_rgb = _resize_to_rgb(img_uint8)          # (D, 3, 512, 512) float32
        imgs_tensor = torch.from_numpy(imgs_rgb).float()

        pred_masks = np.zeros((D, H, W), dtype=np.uint8)

        if foreground:
            # OHIF MONAI Label extension sends clicks as [x, y, z]
            # where x=column, y=row, z=axial slice index
            fg = np.array(foreground)                  # (N, 3): [x, y, z]
            key_slice = int(fg[0, 2])                  # z = depth/slice index

            # Scale (x=col, y=row) from original image size to SAM2_SIZE
            pts = np.array(
                [[c[0] * SAM2_SIZE / W, c[1] * SAM2_SIZE / H] for c in fg],
                dtype=np.float32,
            )
            lbs = np.ones(len(pts), dtype=np.int32)

            if background:
                bg = np.array(background)
                bg_pts = np.array(
                    [[c[0] * SAM2_SIZE / W, c[1] * SAM2_SIZE / H] for c in bg],
                    dtype=np.float32,
                )
                pts = np.vstack([pts, bg_pts])
                lbs = np.concatenate([lbs, np.zeros(len(bg_pts), dtype=np.int32)])

            predictor = self._get_predictor(device)

            with torch.inference_mode():
                # Forward from key slice
                state = predictor.init_state(
                    imgs_tensor, video_height=SAM2_SIZE, video_width=SAM2_SIZE
                )
                predictor.add_new_points_or_box(
                    inference_state=state,
                    frame_idx=key_slice,
                    obj_id=1,
                    points=pts,
                    labels=lbs,
                )
                for fi, _, logits in predictor.propagate_in_video(
                    state, start_frame_idx=key_slice, reverse=False
                ):
                    pred_masks[fi] = _collect_masks(logits, H, W)

                # Backward from key slice
                predictor.reset_state(state)
                state = predictor.init_state(
                    imgs_tensor, video_height=SAM2_SIZE, video_width=SAM2_SIZE
                )
                predictor.add_new_points_or_box(
                    inference_state=state,
                    frame_idx=key_slice,
                    obj_id=1,
                    points=pts,
                    labels=lbs,
                )
                for fi, _, logits in predictor.propagate_in_video(
                    state, start_frame_idx=key_slice, reverse=True
                ):
                    pred_masks[fi] = _collect_masks(logits, H, W)

        # ── Write output via SimpleITK (copies spatial metadata exactly) ──────
        # OHIF MONAI Label extension requests .nrrd by default; honor whatever was sent
        ext = request.get("result_extension", ".nrrd")
        if not ext.startswith("."):
            ext = "." + ext
        output_file = tempfile.NamedTemporaryFile(suffix=ext, delete=False).name
        pred_sitk = sitk.GetImageFromArray(pred_masks.astype(np.uint16))
        pred_sitk.CopyInformation(sitk_img)
        sitk.WriteImage(pred_sitk, output_file)

        result_json = {"label_names": self.labels}
        return output_file, result_json
