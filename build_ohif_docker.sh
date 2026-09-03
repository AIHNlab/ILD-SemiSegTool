#!/bin/bash
# Builds the OHIF viewer (plugins/ohifv3/Viewers/platform/app/dist) inside
# Docker — no Node/yarn/corepack needed on the host, and the result is the
# same on Windows/macOS/Linux since no GPU is involved in this half of the
# stack (unlike the MONAI Label backend — see setup_linux.sh for that).
#
# Usage: ./build_ohif_docker.sh
# Then deploy dist/ into your MONAI Label install — see start_linux.txt
# step 6, or just re-run setup_linux.sh's deploy snippet:
#   conda activate ild-ohif
#   MONAILABEL_SITE_PACKAGES="$(python -c 'import monailabel, os; print(os.path.dirname(os.path.dirname(monailabel.__file__)))')"
#   rm -rf "$MONAILABEL_SITE_PACKAGES/monailabel/endpoints/static/ohif"
#   cp -r plugins/ohifv3/Viewers/platform/app/dist "$MONAILABEL_SITE_PACKAGES/monailabel/endpoints/static/ohif"
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIEWERS_DIR="$REPO_DIR/plugins/ohifv3/Viewers"

echo "==> Building the ohif-viewer-builder image"
docker build -t ild-ohif-viewer-builder -f "$REPO_DIR/plugins/ohifv3/docker/Dockerfile.build" "$REPO_DIR/plugins/ohifv3/docker"

echo "==> Running yarn install + production build inside the container"
echo "    (mounts $VIEWERS_DIR — node_modules and dist/ land there on your host)"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$VIEWERS_DIR:/viewers" \
  ild-ohif-viewer-builder

echo ""
echo "Built: $VIEWERS_DIR/platform/app/dist"
echo "Deploy it into your MONAI Label install (see the comment at the top of this script)."
