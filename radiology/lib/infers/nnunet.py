import os, glob, tempfile, torch
from monailabel.interfaces.tasks.infer_v2 import InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask
from lib.infers.prompt_utils import normalize_ct, bbox_mask, polygon_mask, point_outline, exclude_region_mask

# floor on the in-plane crop size so a tiny drawn box still gives nnU-Net
# enough context to run its sliding-window inference meaningfully
XY_MIN_SIZE = 96

# same idea, through-plane, for a point prompt's z window (see _roi_to_bbox's
# full_depth=False path) - must match SemiSegmentation.tsx's
# POINT_Z_MARGIN (that's HALF this value, applied on each side of the
# point's own slice) so the frontend's merge never treats a slice nnU-Net
# never actually looked at as "genuinely decided background" there.
Z_MIN_SIZE = 64

class NNUNet(BasicInferTask):
    def __init__(self, model_folder, labels, label_colors=None, folds=(0,),
                 checkpoint="checkpoint_final.pth", **kwargs):
        super().__init__(path=None, network=None, type="segmentation",
                         labels=labels, dimension=3,
                         description="nnU-Net v2 auto-segmentation", **kwargs)
        self._label_colors = label_colors or {}

        from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
        device = torch.device("cuda", 0) if torch.cuda.is_available() else torch.device("cpu")
        self.predictor = nnUNetPredictor(
            tile_step_size=0.5, use_gaussian=True, use_mirroring=True,
            device=device)
        self.predictor.initialize_from_trained_model_folder(
            model_folder, use_folds=folds, checkpoint_name=checkpoint)

    def is_valid(self) -> bool:
        return True

    # required abstract stubs — unused because we override __call__
    def pre_transforms(self, data=None):
        return []

    def post_transforms(self, data=None):
        return []

    def _roi_to_bbox(self, roi, shape, full_depth=True):
        x0, y0, z0 = roi["start"]
        x1, y1, z1 = roi["end"]
        xmin, xmax = sorted((int(x0), int(x1)))
        ymin, ymax = sorted((int(y0), int(y1)))

        # pad in-plane box up to XY_MIN_SIZE, centered on the drawn box
        if xmax - xmin < XY_MIN_SIZE:
            cx = (xmin + xmax) // 2
            xmin, xmax = cx - XY_MIN_SIZE // 2, cx + XY_MIN_SIZE // 2
        if ymax - ymin < XY_MIN_SIZE:
            cy = (ymin + ymax) // 2
            ymin, ymax = cy - XY_MIN_SIZE // 2, cy + XY_MIN_SIZE // 2

        xmin, xmax = max(0, xmin), min(shape[0], xmax)
        ymin, ymax = max(0, ymin), min(shape[1], ymax)
        if full_depth:
            # a hand-drawn box/freehand outline only specifies an in-plane
            # region - the finding it's meant to capture can run through the
            # whole study regardless of how many slices that particular
            # study has, so z is never restricted
            zmin, zmax = 0, shape[2]
        else:
            # points: roi's z is just the single slice the point-derived
            # hull/clip was grown on (see __call__'s foreground branch) - a
            # 2D shape found via local pixel similarity on ONE slice has no
            # basis for being reapplied to unrelated slices elsewhere in the
            # study, unlike a shape the user deliberately drew themselves.
            # Pad up to Z_MIN_SIZE (same centered-padding style as XY above)
            # instead of cropping to exactly that one slice, so nnU-Net still
            # gets real neighboring 3D context to classify with.
            cz = int(z0)  # roi's start/end z are always equal for points
            zmin, zmax = cz - Z_MIN_SIZE // 2, cz + Z_MIN_SIZE // 2
            zmin, zmax = max(0, zmin), min(shape[2], zmax)
        return xmin, xmax, ymin, ymax, zmin, zmax

    def __call__(self, request, callbacks=None):
        import numpy as np, nibabel as nib, SimpleITK as sitk, logging
        log = logging.getLogger(__name__)
        image_path = request.get("image")
        in_dir, out_dir = tempfile.mkdtemp(), tempfile.mkdtemp()

        roi = request.get("roi")
        mask_polygon = request.get("mask_polygon")  # [[x, y], ...] on one slice
        roi_slice = request.get("roi_slice")
        foreground = request.get("foreground")  # [[x, y, z], ...]
        exclude_shapes = request.get("exclude_shapes")  # [{"type": "point"|"box"|"polygon", ...}, ...]
        clip = None  # (h, w) mask restricting the final result in-plane, or None
        # roi/mask_polygon are shapes the user deliberately drew - classify
        # them through the whole study depth (see _roi_to_bbox). foreground
        # (points) overrides this to False below: its hull is auto-grown
        # from local pixel similarity on a single slice, with no basis for
        # being reapplied to other slices.
        full_depth = True

        orig_nii = None
        orig_arr = None
        if roi or mask_polygon or foreground:
            orig_nii = nib.load(image_path)
            orig_arr = np.asanyarray(orig_nii.dataobj)  # (X, Y, Z)
            w, h = orig_arr.shape[0], orig_arr.shape[1]

            if roi:
                # the caller already gave an exact box - clip to it, since
                # _roi_to_bbox's XY_MIN_SIZE padding below is just extra
                # context for nnU-Net's sliding window, not part of the
                # region the caller actually asked for
                clip = bbox_mask(w, h, *roi["start"][:2], *roi["end"][:2])
            elif mask_polygon:
                xs = [v[0] for v in mask_polygon]
                ys = [v[1] for v in mask_polygon]
                z = int(roi_slice)
                roi = {"start": [min(xs), min(ys), z], "end": [max(xs), max(ys), z]}
                clip = polygon_mask(mask_polygon, w, h)
            else:
                # Points are seeds for one shared outline: region growing
                # (random_walker) from them respects real tissue similarity
                # instead of just connecting the clicks geometrically, and
                # taking the convex hull of whatever it actually grew into
                # re-encloses that into one smooth, fully-filled shape -
                # avoiding both a naive straight-edged hull of the raw
                # clicks AND the scattered/patchy result raw region growing
                # gives on ILD patterns' noisy internal texture. What's
                # actually classified inside is still this model's own call.
                full_depth = False
                fg = np.array(foreground)
                z = int(fg[0, 2])
                img_slice = normalize_ct(orig_arr[:, :, z].T)  # (X,Y) -> (Y,X) = (h,w)
                hull = point_outline(img_slice, fg[:, :2].tolist(), w, h)
                if hull is not None:
                    roi = {
                        "start": [int(hull[:, 0].min()), int(hull[:, 1].min()), z],
                        "end": [int(hull[:, 0].max()), int(hull[:, 1].max()), z],
                    }
                    clip = polygon_mask(hull.tolist(), w, h)
                else:
                    # not enough points yet (or collinear) for an enclosed
                    # area - fall back to a plain crop around them, nnU-Net's
                    # own padding (XY_MIN_SIZE) still applies, no further clip
                    roi = {
                        "start": [int(fg[:, 0].min()), int(fg[:, 1].min()), z],
                        "end": [int(fg[:, 0].max()), int(fg[:, 1].max()), z],
                    }
                    clip = None

            if exclude_shapes:
                # nnU-Net is a plain classifier - it has no prompt input to
                # feed a negative region into, so excluding one is only
                # possible after the fact: carve it out of whatever clip
                # (or full result, if there was none) applies.
                ex_mask = exclude_region_mask(w, h, exclude_shapes)
                clip = ex_mask if clip is None else (clip & ex_mask)

        # Full-volume runs (no roi/mask_polygon/foreground - the plain
        # Auto-Segmentation "Run" button) feed nnU-Net the resampled +
        # body-bbox-cropped volume instead of the raw original: nnunet_lung/
        # nnunet_ild were trained on data prepared the same way (see
        # preprocessing/preprocess_test_ct.py's history), so this matches
        # what the models actually expect. The result is mapped back onto
        # the original image's exact grid below (map_result_to_original)
        # before anything downstream - including the OHIF viewport, which
        # always shows the untouched original DICOM series - ever sees it.
        # ROI/prompt-driven runs are left exactly as before: the caller's
        # roi/mask_polygon/foreground coordinates are in the ORIGINAL
        # image's voxel space, so cropping to the preprocessed grid first
        # would require re-deriving all of those in that grid too.
        original_img = None
        bbox = None
        if roi:
            bbox = self._roi_to_bbox(roi, orig_nii.shape, full_depth=full_depth)
            xmin, xmax, ymin, ymax, zmin, zmax = bbox
            log.info(f"NNUNET ROI crop: x[{xmin}:{xmax}] y[{ymin}:{ymax}] z[{zmin}:{zmax}]")

            crop_arr = orig_arr[xmin:xmax, ymin:ymax, zmin:zmax]

            crop_affine = orig_nii.affine.copy()
            crop_affine[:3, 3] += crop_affine[:3, :3] @ np.array([xmin, ymin, zmin])

            crop_nii = nib.Nifti1Image(crop_arr, crop_affine, header=orig_nii.header)
            nib.save(crop_nii, os.path.join(in_dir, "case_0000.nii.gz"))
        else:
            from lib.preprocess import preprocess_for_inference
            preprocessed_img, original_img = preprocess_for_inference(image_path)
            sitk.WriteImage(preprocessed_img, os.path.join(in_dir, "case_0000.nii.gz"))

        # num_processes_preprocessing/num_processes_segmentation_export default to
        # 8 each (nnunetv2.configuration.default_num_processes), spinning up ~16
        # fresh multiprocessing workers (Manager-based Events/Queues, over named
        # pipes on Windows) for what's always exactly one case here. Repeated
        # inference calls against this long-running server eventually exhaust
        # Windows' named-pipe/handle pool that way (WinError 1450). One case
        # gains nothing from parallel workers anyway, so keep both at 1.
        self.predictor.predict_from_files(in_dir, out_dir,
                                          save_probabilities=False, overwrite=True,
                                          num_processes_preprocessing=1,
                                          num_processes_segmentation_export=1)
        result = glob.glob(os.path.join(out_dir, "*.nii.gz"))[0]

        # uint8, not uint16: the OHIF client (MonaiLabelPanel.updateView) reads the
        # NRRD payload as a Uint8Array unconditionally, so a wider dtype here just
        # gets bytes misaligned/split on the client - fine anyway since label counts
        # are always well under 256
        if bbox:
            xmin, xmax, ymin, ymax, zmin, zmax = bbox
            pred_nii = nib.load(result)
            pred_arr = np.asanyarray(pred_nii.dataobj).astype(np.uint8)
            arr = np.zeros(orig_nii.shape, dtype=np.uint8)
            arr[xmin:xmax, ymin:ymax, zmin:zmax] = pred_arr
        else:
            # Full-volume run: pred_img is on preprocessed_img's grid: map it
            # back onto the original image's grid before anything else sees
            # it (see the preprocess_for_inference call above).
            from lib.preprocess import map_result_to_original

            pred_img = sitk.ReadImage(result)
            pred_img_original = map_result_to_original(pred_img, original_img)
            # sitk gives (z,y,x); flip to nibabel's (x,y,z) so the shared tail
            # below (clip/transpose/CopyInformation) is identical either way
            arr = sitk.GetArrayFromImage(pred_img_original).astype(np.uint8).transpose(2, 1, 0)

        if clip is not None:
            # clip is (h, w) = (y, x); arr is (x, y, z) - transpose to (x, y)
            # and broadcast over z, so freehand/point regions land exactly on
            # the drawn/grown shape instead of nnU-Net's padded rectangular
            # crop around it
            arr *= clip.T[:, :, None]

        log.info(f"NNUNET unique labels: {np.unique(arr)}")

        # nibabel: (x,y,z), sitk needs (z,y,x)
        arr_zyx = np.ascontiguousarray(arr.transpose(2, 1, 0))
        seg = sitk.GetImageFromArray(arr_zyx)
        # copy origin/spacing/direction straight from the source image instead of
        # re-deriving them from the nibabel affine's sign — deriving them by hand
        # requires mirroring the array to match any negated affine axis, which
        # wasn't happening, so the mask landed mirrored/offset from the anatomy
        seg.CopyInformation(sitk.ReadImage(image_path))

        fixed = os.path.join(out_dir, "seg.nrrd")
        sitk.WriteImage(seg, fixed, useCompression=True)
        log.info(f"WROTE {fixed} size={os.path.getsize(fixed)}")
        return fixed, {
            "label_names": self.labels,
            "label_colors": self._label_colors,
            "centroids": {},
        }
