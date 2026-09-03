#!/bin/bash
# One-shot setup for the ILD-OHIF-Tool backend (Orthanc + MONAI Label server)
# on Linux. Companion to start_linux.txt — read that for what this does and
# how to run the servers afterwards; this script only installs things.
#
# Idempotent: safe to re-run. Does NOT touch the OHIF viewer (Node/yarn) side
# — that's a separate, much slower step; see start_linux.txt step 5.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="ild-ohif"

echo "==> [1/6] GPU check"
if ! command -v nvidia-smi >/dev/null; then
  echo "    WARNING: nvidia-smi not found — no NVIDIA driver detected." \
       "The nnU-Net/SAM2 models need a GPU; inference will fail or be very slow without one."
else
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
fi

echo "==> [2/6] Orthanc (DICOM server) via Docker"
if ! docker info >/dev/null 2>&1; then
  echo "    ERROR: can't talk to Docker. If this is 'permission denied', your" \
       "user is probably in the docker group already but this shell predates" \
       "it — run 'newgrp docker' or open a new terminal, then re-run this script."
  exit 1
fi
if [ "$(docker inspect -f '{{.State.Running}}' orthanc 2>/dev/null)" = "true" ]; then
  echo "    already running"
elif docker inspect orthanc >/dev/null 2>&1; then
  docker start orthanc
else
  docker run -d --name orthanc \
    -p 8042:8042 -p 4242:4242 \
    -e DICOM_WEB_PLUGIN_ENABLED=true \
    -e ORTHANC__AUTHENTICATION_ENABLED=false \
    orthancteam/orthanc
fi

echo "==> [3/6] Miniconda"
if [ ! -d "$HOME/miniconda3" ]; then
  curl -sS -o /tmp/miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
  bash /tmp/miniconda.sh -b -p "$HOME/miniconda3"
  rm -f /tmp/miniconda.sh
  "$HOME/miniconda3/bin/conda" init bash >/dev/null
fi
# shellcheck disable=SC1091
source "$HOME/miniconda3/etc/profile.d/conda.sh"
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main >/dev/null 2>&1 || true
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r >/dev/null 2>&1 || true

echo "==> [4/6] Conda env '$ENV_NAME' (python 3.10)"
# python 3.10 is required: newer Python breaks monailabel's numpymaxflow dep
# (pins numpy==1.26.0, no wheel past 3.12), so don't "upgrade" this later.
if ! conda env list | grep -qE "^\s*${ENV_NAME}\s"; then
  conda create -n "$ENV_NAME" python=3.10 -y
fi
conda activate "$ENV_NAME"

echo "==> [5/6] Python packages"
pip install --upgrade pip -q
pip install torch -q
pip install monailabel nnunetv2 -q
pip install -r "$REPO_DIR/radiology/requirements.txt" -q

# --- Fix 1: numpy pin -------------------------------------------------
# MedSAM2 (just installed above) floors numpy>=2.0.1, which breaks
# monailabel's numpymaxflow — its numpymaxflowcpp extension is a compiled
# binary built against the numpy<2 ABI ("numpy.core.multiarray failed to
# import" at runtime with numpy 2.x). Force it back down; MedSAM2 runs fine
# on 1.26.4 in practice despite its stated floor (see radiology/requirements.txt).
pip install "numpy==1.26.4" --no-deps -q

# --- Fix 2: pydicom_seg vs pydicom 3.x --------------------------------
# pydicom_seg 0.4.1 (unmaintained upstream) still imports
# `pydicom._storage_sopclass_uids`, a module pydicom 3.0 removed. Don't
# downgrade pydicom to work around this — dicomweb-client and pynetdicom
# (both pulled in by monailabel) require pydicom>=3 and genuinely use its
# newer API (e.g. pydicom.encaps.parse_basic_offsets doesn't exist in 2.x).
# Patch the two files instead; SegmentationStorage lives at pydicom.uid in
# both the old and new pydicom.
PYDICOM_SEG_DIR="$(python -c 'import site; print(site.getsitepackages()[0])')/pydicom_seg"
sed -i 's/from pydicom\._storage_sopclass_uids import SegmentationStorage/from pydicom.uid import SegmentationStorage/' \
  "$PYDICOM_SEG_DIR/reader.py" "$PYDICOM_SEG_DIR/segmentation_dataset.py"

# --- Fix 3: missing "list saved labels" endpoint ----------------------
# Stock monailabel has no HTTP route for "list every saved label for this
# image", which the OHIF Load Segmentation picker needs. See
# radiology/patch_monailabel_datastore.py for details; idempotent, safe to
# re-run after a monailabel upgrade.
python "$REPO_DIR/radiology/patch_monailabel_datastore.py"

# --- MedSAM2's missing Hydra configs ----------------------------------
# MedSAM2's pip build doesn't ship its Hydra config yamls (missing
# MANIFEST.in upstream). Copy them in from the source repo.
SAM2_CONFIGS_DIR="$(python -c 'import sam2, os; print(os.path.dirname(sam2.__file__))')/configs"
if [ ! -f "$SAM2_CONFIGS_DIR/sam2.1_hiera_t512.yaml" ]; then
  TMP_MEDSAM2="$(mktemp -d)"
  git clone --depth 1 -q https://github.com/bowang-lab/MedSAM2.git "$TMP_MEDSAM2"
  cp "$TMP_MEDSAM2"/sam2/configs/*.yaml "$SAM2_CONFIGS_DIR/"
  rm -rf "$TMP_MEDSAM2"
fi

echo "==> [6/6] Model weights (symlinked from Annotation_Tool_Test_Data)"
MODEL_WEIGHTS_DIR="$REPO_DIR/Annotation_Tool_Test_Data/model_weights"
if [ ! -d "$MODEL_WEIGHTS_DIR" ]; then
  echo "    WARNING: $MODEL_WEIGHTS_DIR not found — skipping." \
       "Extract Annotation_Tool_Test_Data.zip first, or place weights under radiology/model/ yourself."
else
  mkdir -p "$REPO_DIR/radiology/model/sam2"
  [ -e "$REPO_DIR/radiology/model/nnUNet_results" ] || \
    ln -s "$MODEL_WEIGHTS_DIR/nnUNet_results" "$REPO_DIR/radiology/model/nnUNet_results"
  [ -e "$REPO_DIR/radiology/model/sam2/checkpoint_ild.pt" ] || \
    ln -s "$MODEL_WEIGHTS_DIR/MedSAM2+nnUnet_results/Full Finetune_b4e60/checkpoint_best_val.pt" \
      "$REPO_DIR/radiology/model/sam2/checkpoint_ild.pt"
fi

echo ""
echo "==> Verifying"
python -c "import torch; print('torch:', torch.__version__, '| CUDA available:', torch.cuda.is_available())"
python -c "import monailabel.app" && echo "monailabel.app: import ok"

echo ""
echo "Backend setup complete. Start the server with:"
echo "  conda activate $ENV_NAME"
echo "  cd $REPO_DIR"
echo "  python -m monailabel.main start_server --app radiology --studies http://localhost:8042/dicom-web --conf models nnunet_lung,nnunet_ild,sam2_ild"
echo ""
echo "For the OHIF viewer (Node/yarn side): ./build_ohif_docker.sh (no Node needed), or see start_linux.txt step 5."
