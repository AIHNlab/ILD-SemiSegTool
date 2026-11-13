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

Runs on **Linux, Windows or macOS** in containers, with **Docker or Podman -
your choice** (both work the same; `./manage.sh` handles either). An NVIDIA
GPU is used automatically when available. Without one, everything still works
on the CPU, just slower: a lung segmentation takes about 3–4 minutes instead
of 1, and a MedSAM2 box about 45 s instead of 10 s.

You need: **Git**, a **container engine** with the **docker-compose** program,
for a GPU the **NVIDIA driver** and **NVIDIA Container Toolkit**, and the
**model weights** (see [Model weights](#model-weights)).

**Docker or Podman?**

| | Docker | Podman |
|---|---|---|
| Admin rights | needed to install, and to run (or membership of the `docker` group) | needed once to install; then runs **rootless** as your own user |
| Good for | your own PC or a server you administer; Windows and macOS (Docker Desktop) | university/hospital servers without admin rights |
| Files it writes in `docker/data/` | owned by root | owned by you |

If both are installed, `./manage.sh init` asks which one to use and saves it as
`ENGINE=` in `docker/.env` (change it there any time). Pick your system:

### Linux - Ubuntu / Debian

Commands with `sudo` need admin rights once; no admin rights? Use Podman and
send the `sudo` lines to your IT (see [Without admin rights](#without-admin-rights)).

**1. Git**

```bash
sudo apt-get update && sudo apt-get install -y git curl
```

**2. Container engine - option A: Docker** (includes docker-compose)

```bash
curl -fsSL https://get.docker.com | sudo sh        # Docker's official installer
sudo usermod -aG docker $USER                      # run docker without sudo - log out and back in after this
```

**2. Container engine - option B: Podman** (rootless)

```bash
sudo apt-get install -y podman uidmap slirp4netns
# docker-compose for your user - podman runs it (no admin rights needed)
mkdir -p ~/.docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
  -o ~/.docker/cli-plugins/docker-compose && chmod +x ~/.docker/cli-plugins/docker-compose
```

**3. NVIDIA GPU:** follow [NVIDIA GPU](#nvidia-gpu-linux-and-wsl) below - all four
steps, including the test. Skipping a step makes the AI quietly run on the CPU.

### Linux - RHEL / Rocky / Fedora

```bash
sudo dnf install -y git curl

# option A: Docker (includes docker-compose)
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker && sudo usermod -aG docker $USER   # then log out and back in

# option B: Podman (rootless)
sudo dnf install -y podman
mkdir -p ~/.docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
  -o ~/.docker/cli-plugins/docker-compose && chmod +x ~/.docker/cli-plugins/docker-compose
```

NVIDIA GPU: follow [NVIDIA GPU](#nvidia-gpu-linux-and-wsl) below - all four steps.

### NVIDIA GPU (Linux and WSL)

Skip this without an NVIDIA GPU, on macOS, and with Docker Desktop (it brings
its own GPU support - only the Windows driver is needed). Everywhere else **all
four steps are required** - if one is missing, nothing fails: the AI just runs
on the CPU, 4-5x slower.

**1. Driver.** Check with `nvidia-smi` - it must list your GPU.
- Ubuntu: `sudo ubuntu-drivers install && sudo reboot` (Debian: `sudo apt-get install -y nvidia-driver`, needs `non-free`)
- RHEL/Rocky: [NVIDIA's guide](https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/); Fedora: `akmod-nvidia` from RPM Fusion
- **WSL: never install a driver inside WSL** - install/update the [Windows driver](https://www.nvidia.com/Download/index.aspx) and restart Windows.

**2. NVIDIA Container Toolkit.** Check with `nvidia-ctk --version`.

```bash
# Ubuntu / Debian / WSL
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit

# RHEL / Rocky / Fedora
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit
```

**3. Connect the toolkit to your container engine** - easy to miss: installing
the toolkit alone is not enough. Which engine? `docker info` working = Docker
(`docker/.env` uses Docker when it's running, unless `ENGINE=podman`); otherwise Podman.

| Engine | Command |
|---|---|
| Podman on Linux | `sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service` |
| Podman in WSL | `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml` (re-run after Windows driver updates) |
| Docker Engine (Linux or WSL) | `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker` (WSL without systemd: `sudo service docker restart`) |
| Docker Desktop | nothing |

**4. Test - must print your GPU:**

```bash
podman run --rm --device nvidia.com/gpu=all docker.io/library/ubuntu:22.04 nvidia-smi -L   # Podman
docker run --rm --gpus all ubuntu:22.04 nvidia-smi -L                                    # Docker
```

If it errors or shows no GPU, `./manage.sh check-gpu` (after cloning) says
which step is missing.

### Windows 10/11

1. Install [Git for Windows](https://git-scm.com/download/win) - run every
   command below in its **Git Bash**.
2. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
   with the **WSL 2** engine (the default).
3. NVIDIA GPU: install the current [NVIDIA driver for Windows](https://www.nvidia.com/Download/index.aspx).
   That's all - Docker Desktop brings the rest.

**Podman or Docker Engine inside WSL instead of Docker Desktop:** follow the
Ubuntu steps inside WSL, then **all four** [NVIDIA GPU](#nvidia-gpu-linux-and-wsl)
steps - with the Windows driver, and the WSL row in step 3.

### macOS (Intel or Apple Silicon)

1. Git: run `xcode-select --install` in Terminal.
2. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/);
   in Settings → Resources give it at least **8 GB memory** (an AI run peaks at about 4.5 GB).
3. Macs have no NVIDIA GPU support - the AI runs on the CPU.

### Without admin rights

Use **Podman** (Docker needs admin rights to run). On a university or hospital
server, ask IT to do these once (as root):

1. Install `podman` (and `uidmap slirp4netns` on Debian/Ubuntu) - the commands in step 1 above.
2. Give your account user-namespace ranges, if `grep $USER /etc/subuid` shows nothing:
   `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 <you>`
3. For a GPU: [NVIDIA GPU](#nvidia-gpu-linux-and-wsl) steps 1-3 (driver, toolkit
   1.18 or newer, the Podman row of step 3) - then you run the step 4 test yourself.
4. `sudo loginctl enable-linger <you>` - keeps the site running after you log
   out and starts it after a reboot (`./manage.sh up` tries this itself first).

Everything else - docker-compose, building, running, updates - you do as your
own user. Use ports above 1024 (the defaults, 8080/8443, are fine).

### Set up and start

```bash
git clone https://github.com/AIHNlab/ILD-SemiSegTool.git
cd ILD-SemiSegTool/docker

./manage.sh init                  # creates .env, checks the GPU and the model weights (and what's missing)
#   GPU machine? init must print "OK: the NVIDIA GPU is ready" before you build -
#   build makes either the GPU or the CPU version of the AI image. If it says CPU,
#   fix the missing step it lists, then run init again.
./manage.sh build                 # builds the images (first time: 20-40 min)
./manage.sh add-user alice --admin    # asks for a password
./manage.sh up                    # starts everything, prints the address and opens it in your browser
```

`up` prints `AI backend: NVIDIA GPU` or `CPU`. Fixed the GPU after building for
the CPU? Run `./manage.sh build` again, then `up`.

### Open it

Go to `http://localhost:8080/` on the same machine, or
`http://<this-machine's-IP>:8080/` from other devices. Use **Chrome, Edge or
Safari**; Firefox shows grey images. Log in as `alice`, then upload a CT study
with **Upload** on the study list.

Accounts, monitoring, backups and troubleshooting are covered in
[docker/README.md](docker/README.md).

## Model weights

The weights always go in the repo's **`backend/model/`** folder (not tracked
by git), in the same layout as their release on Hugging Face
([AIHNLab/ILD-SemiSegTool](https://huggingface.co/AIHNLab/ILD-SemiSegTool),
folder `HuggingFace/`). `./manage.sh init` (and `up`) downloads any that are
missing (~1.2 GB, needs `curl`); `./manage.sh fetch-models` retries an
interrupted download. Files already there are never replaced.

```
backend/model/
├── nnUNet_weights/
│   ├── Lung/          plans.json, dataset.json, checkpoint_best.pth   nnunet_lung
│   ├── ILD_raw/       plans.json, dataset.json, checkpoint_best.pth   nnunet_ild
│   └── Airways/       plans.json, dataset.json, checkpoint_best.pth   nnunet_airways
└── MedSAM2+nnUNet_weights/
    └── checkpoint_best_val.pt                                          sam2_ild
```

To add them by hand, copy the files themselves, not links: a link pointing
outside `backend/model/` can't be followed inside the container.

`./manage.sh check-models` lists anything missing, with its full path (`init`
and `up` run it too; `up` won't start without the weights). To load fewer
models, remove them from `MODELS` in `docker/.env`.

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
