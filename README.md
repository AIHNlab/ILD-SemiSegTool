# ILD SemiSeg Tool

A web tool for segmenting interstitial lung disease (ILD) in chest CT. Users log
in through a browser, upload their CT studies, view them in OHIF, and segment
them with AI models: automatic segmentation (lung, ILD, airways via nnU-Net)
and prompt-guided interactive segmentation (MedSAM2 fine-tuned for ILD).
Each user has their own private study list, available from any device.

The model weights and plug-ins for the paper *"Prompt-Guided Interactive
Segmentation of Interstitial Lung Disease in Thoracic CT"* (TIA 2026 @ MICCAI
2026) are maintained here.

## Installation

Runs on **Linux, Windows or macOS** in containers, with **Podman** (works
without admin rights, recommended on Linux servers) or **Docker**. An NVIDIA
GPU is used automatically when available. Without one, everything still works
on the CPU, just slower: a lung segmentation takes about 3–4 minutes instead
of 1, and a MedSAM2 box about 45 s instead of 10 s.

You need: **Git**, a **container engine** with the **docker-compose** program,
for a GPU the **NVIDIA driver** and **NVIDIA Container Toolkit**, and the
**model weights** (see [Model weights](#model-weights)). Pick your system:

### Linux - Ubuntu / Debian

Commands with `sudo` need admin rights once; no admin rights? Send them to your
IT (see [Without admin rights](#without-admin-rights)).

```bash
# 1. Git + Podman
sudo apt-get update
sudo apt-get install -y git curl podman uidmap slirp4netns

# 2. docker-compose for your user (podman runs it; no admin rights needed)
mkdir -p ~/.docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
  -o ~/.docker/cli-plugins/docker-compose && chmod +x ~/.docker/cli-plugins/docker-compose
```

**3. NVIDIA GPU only** (skip without one):

```bash
# Driver (skip if `nvidia-smi` already works), then reboot
sudo ubuntu-drivers install          # Debian: sudo apt-get install -y nvidia-driver (needs non-free)
sudo reboot

# NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit

# Describe the GPU to Podman, kept current across reboots and driver updates
sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service
```

Not sure what's missing? After cloning ([Set up and start](#set-up-and-start)), `./manage.sh check-gpu`
says exactly which of these your machine still needs.

### Linux - RHEL / Rocky / Fedora

```bash
sudo dnf install -y git curl podman
mkdir -p ~/.docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
  -o ~/.docker/cli-plugins/docker-compose && chmod +x ~/.docker/cli-plugins/docker-compose
```

NVIDIA GPU: install the driver ([NVIDIA's guide](https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/);
Fedora: `akmod-nvidia` from RPM Fusion), then:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit
sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service
```

### Windows 10/11

1. Install [Git for Windows](https://git-scm.com/download/win) - run every
   command below in its **Git Bash**.
2. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
   with the **WSL 2** engine (the default).
3. NVIDIA GPU: install the current [NVIDIA driver for Windows](https://www.nvidia.com/Download/index.aspx).
   That's all - Docker Desktop brings the rest.

### macOS (Intel or Apple Silicon)

1. Git: run `xcode-select --install` in Terminal.
2. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/);
   in Settings → Resources give it at least **8 GB memory** (an AI run peaks at about 4.5 GB).
3. Macs have no NVIDIA GPU support - the AI runs on the CPU.

### Already have Docker?

On Linux, Docker Engine with the Compose plugin works too (`ENGINE=auto` in
`docker/.env` uses Docker when it's running). For a GPU it needs the toolkit
above plus `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`
instead of the `nvidia-cdi-refresh` line.

### Without admin rights

On a university or hospital server, ask IT to do these once (as root):

1. Install `podman` (and `uidmap slirp4netns` on Debian/Ubuntu) - the commands in step 1 above.
2. Give your account user-namespace ranges, if `grep $USER /etc/subuid` shows nothing:
   `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 <you>`
3. For a GPU: the NVIDIA driver, the NVIDIA Container Toolkit (1.18 or newer)
   and `nvidia-cdi-refresh` enabled - step 3 above.
4. `sudo loginctl enable-linger <you>` - keeps the site running after you log
   out and starts it after a reboot (`./manage.sh up` tries this itself first).

Everything else - docker-compose, building, running, updates - you do as your
own user. Use ports above 1024 (the defaults, 8080/8443, are fine).

### Set up and start

```bash
git clone https://github.com/AIHNlab/ILD-SemiSegTool.git
cd ILD-SemiSegTool/docker

./manage.sh init                  # creates .env, checks the GPU (and what's missing) - then set the model weight paths in .env
./manage.sh build                 # builds the images (first time: 20-40 min)
./manage.sh add-user alice --admin    # asks for a password
./manage.sh up                    # starts everything, prints the address and opens it in your browser
```

### Open it

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
