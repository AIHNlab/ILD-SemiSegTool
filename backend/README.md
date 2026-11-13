# backend - MONAI Label app

The AI side of the tool. It runs inside the `monailabel` container (see
[docker/](../docker/README.md)), which mounts this folder, so after a code
change run `./manage.sh restart monailabel`.

## Models (`--conf models`, set by `MODELS` in `docker/.env`)

| Name | Config | What it does |
|---|---|---|
| `nnunet_lung` | `lib/configs/nnunet_lung.py` | Automatic lung segmentation (nnU-Net) |
| `nnunet_ild` | `lib/configs/nnunet_ild.py` | Automatic ILD segmentation (nnU-Net) |
| `nnunet_airways` | `lib/configs/nnunet_airways.py` | Automatic airway segmentation (nnU-Net) |
| `sam2_ild` | `lib/configs/sam2_ild.py` | Prompt-guided interactive ILD segmentation (MedSAM2) |

Model weights live in `model/`, laid out like their Hugging Face release (`model/nnUNet_weights/<Model>/`,
`model/MedSAM2+nnUNet_weights/checkpoint_best_val.pt` - see the [main README](../README.md#model-weights)); Docker/Podman mount
this folder into the AI container as `/app/backend/model`. The other configs in `lib/configs/` (deepedit,
segmentation, ...) are MONAI Label's stock sample models and are not loaded
unless listed in `MODELS`.

## Files

| Path | Purpose |
|---|---|
| `main.py` | The app: loads the models, picks each user's own datastore, queues GPU runs |
| `lib/user_context.py` | Reads the logged-in user (set by the gateway) for each request |
| `lib/infers/nnunet.py`, `lib/infers/sam2_interactive.py` | Inference code |
| `lib/regional_stats.py` | Regional Stats tab: 12-region ILD volume statistics |
| `lib/preprocess.py` | Preprocessing tab (uses `../preprocessing/`) |
| `patch_monailabel_datastore.py` | Adds the extra endpoints above to MONAI Label; run at image build |
| `bin/itkimage2segimage` | DICOM-SEG export helper |
