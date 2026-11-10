# ILD SemiSeg Tool

A web tool for segmenting interstitial lung disease (ILD) in chest CT. Users log
in through a browser, upload their CT studies, view them in OHIF, and segment
them with AI models: automatic segmentation (lung, ILD, airways via nnU-Net)
and prompt-guided interactive segmentation (MedSAM2 fine-tuned for ILD).
Each user has their own private study list, available from any device.

The model weights and plug-ins for the paper *"Prompt-Guided Interactive
Segmentation of Interstitial Lung Disease in Thoracic CT"* (TIA 2026 @ MICCAI
2026) are maintained here.

## Quick start (Docker)

Runs on **Windows, macOS or Linux** with Docker. An NVIDIA GPU is used
automatically when Docker can reach one. Without a GPU, everything still
works on the CPU; automatic segmentation then takes minutes instead of
seconds.

**1. Install Docker**

| OS | Install | Notes |
|---|---|---|
| Windows 10/11 | [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) (WSL 2 backend) | Run the commands below in **Git Bash** (comes with [Git for Windows](https://git-scm.com/download/win)) or a WSL terminal. NVIDIA GPUs work through WSL 2 with a current NVIDIA driver. |
| macOS (Intel or Apple Silicon) | [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) | CPU only. In Docker Desktop → Settings → Resources, give Docker at least **12 GB memory**. |
| Linux | [Docker Engine](https://docs.docker.com/engine/install/) + Compose plugin | For a GPU, also install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). |

You also need the model weights (see [Model weights](#model-weights)).

**2. Set up and start**

```bash
git clone https://github.com/AIHNlab/ILD-SemiSegTool.git
cd ILD-SemiSegTool/docker

./manage.sh init                  # creates .env and detects the GPU - then set the model weight paths in .env
./manage.sh build                 # builds the images (first time: 20-40 min)
./manage.sh add-user alice --admin    # asks for a password
./manage.sh up
```

**3. Open it**

Go to `http://localhost:8080/` on the same machine, or
`http://<this-machine's-IP>:8080/` from other devices. Use **Chrome, Edge or
Safari**; Firefox shows grey images. Log in as `alice`, then upload a CT study
with **Upload** on the study list.

Accounts, monitoring, backups and troubleshooting are covered in
[docker/README.md](docker/README.md).

## Model weights

Point these two settings in `docker/.env` at your copy of the weights
(paths relative to `docker/`, or absolute):

```ini
NNUNET_RESULTS_DIR=/path/to/model_weights/nnUNet_results
SAM2_ILD_CHECKPOINT="/path/to/model_weights/MedSAM2+nnUnet_results/Full Finetune_b4e60/checkpoint_best_val.pt"
```

`nnUNet_results` must contain:

| Model (`MODELS` in `.env`) | Folder |
|---|---|
| `nnunet_lung` | `Dataset001_Lung/nnUNetTrainer__nnUNetPlans__3d_fullres/` |
| `nnunet_ild` | `Dataset003_ILD_raw/nnUNetTrainer__nnUNetPlans__3d_fullres/` |
| `nnunet_airways` | `Dataset005_Airways/airways.pth` |
| `sam2_ild` | the MedSAM2 checkpoint in `SAM2_ILD_CHECKPOINT` |

To load fewer models, remove them from `MODELS` in `.env`.

## Repository layout

```
docker/          Everything to run the tool: docker-compose.yml, manage.sh,
                 .env.example, and the gateway / login / monailabel images
backend/         MONAI Label app: model configs and inference (nnU-Net,
                 MedSAM2), Regional Stats, per-user data access
viewer/          OHIF v3 viewer with the monai-label extension
                 (viewer/extensions/monai-label) - the segmentation UI
preprocessing/   CT resampling/cropping, used by the viewer's Preprocessing tab
```

How the pieces fit:

```
browser ──> gateway (login check, OHIF viewer)
              ├── /dicom-web, /orthanc ──> orthanc-<user>   (that user's studies)
              └── /monai ──────────────> monailabel (GPU/CPU) ─> orthanc-<user>
```

## Development

- **Backend** (`backend/`): the code is mounted into the container, so after
  an edit run `./manage.sh restart monailabel` in `docker/`.
- **Viewer** (`viewer/`): the viewer is built into the gateway image, so run
  `./manage.sh build gateway && ./manage.sh up`.
- **Viewer settings** (`docker/gateway/app-config.js`): run
  `./manage.sh restart gateway`.
- **Python dependencies**: pinned in `docker/monailabel/requirements.lock.txt`.
  After changing them, run `./manage.sh build monailabel && ./manage.sh up`.

## Paper

This repository accompanies our paper:

**Prompt-Guided Interactive Segmentation of Interstitial Lung Disease in Thoracic CT**
Vasilis Dedousis†, Lubnaa Abdur Rahman†, Lorenzo Brigato, Ethan Dack, Andreas Christe, Justus Roos,
Manuela Funke-Chambour, Frank Christoph, Adrian Huber, Lukas Ebner, and Stavroula Mougiakakou
*Accepted at TIA 2026 @ MICCAI 2026* (†equal contribution)

📄 Paper: [arXiv:2608.28453](https://arxiv.org/abs/2608.28453)

## Citation

If you use this code or the released model weights, please cite:

```bibtex
@article{dedousis2026promptguided,
  title   = {Prompt-Guided Interactive Segmentation of Interstitial Lung Disease in Thoracic CT},
  author  = {Dedousis, Vasilis and Abdur Rahman, Lubnaa and Brigato, Lorenzo and Dack, Ethan and
             Christe, Andreas and Roos, Justus and Funke-Chambour, Manuela and Christoph, Frank and
             Huber, Adrian and Ebner, Lukas and Mougiakakou, Stavroula},
  journal = {arXiv preprint arXiv:2608.28453},
  year    = {2026}
}
```
