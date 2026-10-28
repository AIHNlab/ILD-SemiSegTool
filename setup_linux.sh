#!/bin/bash
# Backend setup for ILD-SemiSegTool on Linux: Orthanc (Docker) + MONAI Label
# server in a Python 3.10 conda env. Idempotent — safe to re-run.
# The OHIF viewer is separate: ./build_ohif_docker.sh (see start_linux.txt).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="ild-ohif"
CONDA_DIR="$HOME/miniconda3"

echo "==> [1/5] Orthanc (Docker)"
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: can't reach Docker. If 'permission denied', run 'newgrp docker' (or re-login) and retry." >&2
  exit 1
fi
if docker inspect orthanc >/dev/null 2>&1; then
  docker start orthanc >/dev/null
else
  docker run -d --name orthanc -p 8042:8042 -p 4242:4242 \
    -e DICOM_WEB_PLUGIN_ENABLED=true -e ORTHANC__AUTHENTICATION_ENABLED=false \
    orthancteam/orthanc
fi

echo "==> [2/5] Conda env '$ENV_NAME' (python 3.10)"
if [ ! -x "$CONDA_DIR/bin/conda" ]; then
  curl -sSL -o /tmp/miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
  bash /tmp/miniconda.sh -b -p "$CONDA_DIR"
  rm -f /tmp/miniconda.sh
fi
CONDA="$CONDA_DIR/bin/conda"
"$CONDA" tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main >/dev/null 2>&1 || true
"$CONDA" tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r >/dev/null 2>&1 || true
# Python 3.10 is required: monailabel's numpymaxflow pins numpy==1.26.0 (no wheel past 3.12).
[ -d "$CONDA_DIR/envs/$ENV_NAME" ] || "$CONDA" create -n "$ENV_NAME" python=3.10 -y
# Use the env's interpreter by absolute path rather than `conda activate`, so an
# already-active venv (e.g. sourced from ~/.bashrc) can't shadow it on PATH.
PY="$CONDA_DIR/envs/$ENV_NAME/bin/python"
PIP=("$PY" -m pip install -q)

echo "==> [3/5] Python packages"
"${PIP[@]}" --upgrade pip
"${PIP[@]}" torch monailabel nnunetv2
"${PIP[@]}" -r "$REPO_DIR/radiology/requirements.txt"
# MedSAM2 pulls numpy>=2, which breaks numpymaxflow's compiled extension; pin it back.
"${PIP[@]}" "numpy==1.26.4" --no-deps

echo "==> [4/5] Patches"
pkg_dir() { "$PY" -c "import importlib.util as u; print(u.find_spec('$1').submodule_search_locations[0])"; }
# pydicom_seg 0.4.1 imports a module removed in pydicom 3 (which monailabel needs).
SEG_DIR="$(pkg_dir pydicom_seg)"
sed -i 's/from pydicom\._storage_sopclass_uids import SegmentationStorage/from pydicom.uid import SegmentationStorage/' \
  "$SEG_DIR/reader.py" "$SEG_DIR/segmentation_dataset.py"
# Adds the "list saved labels" / regional-stats / preprocess endpoints to monailabel.
"$PY" "$REPO_DIR/radiology/patch_monailabel_datastore.py"
# MedSAM2's wheel doesn't ship its Hydra config yamls; copy them from the source repo.
SAM2_CFG="$(pkg_dir sam2)/configs"
if [ ! -f "$SAM2_CFG/sam2.1_hiera_t512.yaml" ]; then
  TMP="$(mktemp -d)"
  git clone --depth 1 -q https://github.com/bowang-lab/MedSAM2.git "$TMP"
  cp "$TMP"/sam2/configs/*.yaml "$SAM2_CFG/"
  rm -rf "$TMP"
fi

echo "==> [5/5] Model weights"
WEIGHTS="$REPO_DIR/Annotation_Tool_Test_Data/model_weights"
if [ -d "$WEIGHTS" ]; then
  mkdir -p "$REPO_DIR/radiology/model/sam2"
  ln -sfn "$WEIGHTS/nnUNet_results" "$REPO_DIR/radiology/model/nnUNet_results"
  ln -sfn "$WEIGHTS/MedSAM2+nnUnet_results/Full Finetune_b4e60/checkpoint_best_val.pt" \
    "$REPO_DIR/radiology/model/sam2/checkpoint_ild.pt"
else
  echo "WARNING: $WEIGHTS not found — extract Annotation_Tool_Test_Data.zip first." >&2
fi

echo "==> Verifying"
"$PY" -c "import torch; print('torch', torch.__version__, '| CUDA:', torch.cuda.is_available())"
"$PY" -c "import monailabel.app, pydicom_seg, sam2; print('imports ok')"

cat <<EOF

Done. Start the server with:
  deactivate 2>/dev/null; conda activate $ENV_NAME   # leave any active venv first
  cd $REPO_DIR
  python -m monailabel.main start_server --app radiology --studies http://localhost:8042/dicom-web --conf models nnunet_lung,nnunet_ild,sam2_ild
EOF
