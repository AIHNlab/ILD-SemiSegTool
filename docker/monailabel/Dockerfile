# MONAI Label + the backend app's models (nnU-Net, MedSAM2), on GPU or CPU.
# Everything the AI backend needs, baked into one image. The app code itself
# (backend/) and the model weights are mounted at run time - see
# docker-compose.yml - so code changes only need a container restart.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3.10 python3-pip python3.10-dev build-essential git ca-certificates \
 && ln -sf /usr/bin/python3.10 /usr/local/bin/python \
 && rm -rf /var/lib/apt/lists/*

# Python 3.10 on purpose: monailabel's numpymaxflow pins numpy==1.26 (no wheels past 3.12).
# torch/torchvision first, so their CUDA libraries come as one matching set.
# TORCH_VARIANT=cu130: NVIDIA GPU build (PyPI default, ~10 GB of CUDA libraries).
# TORCH_VARIANT=cpu:   CPU-only build for machines without an NVIDIA GPU
#                      (Mac, most laptops) - much smaller. Works on x86 and ARM.
ARG TORCH_VARIANT=cu130
RUN python -m pip install --upgrade pip \
 && if [ "$TORCH_VARIANT" = "cpu" ]; then INDEX="--index-url https://download.pytorch.org/whl/cpu"; else INDEX=""; fi \
 && python -m pip install $INDEX torch==2.14.0 torchvision==0.29.0
COPY docker/monailabel/requirements.lock.txt /tmp/requirements.lock.txt
RUN python -m pip install -r /tmp/requirements.lock.txt \
 && python -c "import torch; print('torch', torch.__version__, 'CUDA', torch.version.cuda)"

# MedSAM2 replaces the sam2 module's files (adds build_sam2_video_predictor_npz),
# so it goes in last, without touching the pinned dependencies above.
ARG MEDSAM2_COMMIT=332f30d420f1d1b08e2a79b3ae6a602458808383
RUN python -m pip install --no-deps "MedSAM2 @ git+https://github.com/bowang-lab/MedSAM2.git@${MEDSAM2_COMMIT}" \
 && git clone -q https://github.com/bowang-lab/MedSAM2.git /tmp/medsam2 \
 && git -C /tmp/medsam2 checkout -q ${MEDSAM2_COMMIT} \
 && cp /tmp/medsam2/sam2/configs/*.yaml "$(python -c 'import importlib.util as u; print(u.find_spec("sam2").submodule_search_locations[0])')/configs/" \
 && rm -rf /tmp/medsam2

# Fixes on top of the installed packages: pydicom_seg vs pydicom 3, and the extra
# datastore endpoints (label list, Regional Stats, preprocess).
COPY backend/patch_monailabel_datastore.py /tmp/patch_monailabel_datastore.py
RUN SEG_DIR="$(python -c 'import importlib.util as u; print(u.find_spec("pydicom_seg").submodule_search_locations[0])')" \
 && sed -i 's/from pydicom\._storage_sopclass_uids import SegmentationStorage/from pydicom.uid import SegmentationStorage/' \
      "$SEG_DIR/reader.py" "$SEG_DIR/segmentation_dataset.py" \
 && python /tmp/patch_monailabel_datastore.py

# The stock infer endpoint is an `async def` that calls the slow, blocking
# inference directly, which freezes the whole server for everyone while
# one model runs. As a plain `def`, FastAPI runs it in a worker thread
# instead (its body has no await). Runs still take turns on the GPU - see
# MyApp.infer in backend/main.py.
RUN F="$(python -c 'import monailabel.endpoints.infer as m; print(m.__file__)')" \
 && sed -i 's/^async def api_run_inference(/def api_run_inference(/' "$F" \
 && grep -q '^def api_run_inference(' "$F" \
 && python -c "import sam2.build_sam as b; assert hasattr(b, 'build_sam2_video_predictor_npz')"

WORKDIR /app
ENV PYTHONPATH=/app/backend
