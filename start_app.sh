#!/bin/bash
# Starts the ILD-SemiSegTool stack: Orthanc -> MONAI Label server -> OHIF v3 dev viewer.
# Works on Linux and macOS (Colima). Run setup_linux.sh / setup_mac.sh first.
# Servers run in the background; logs go to radiology/logs/. Stop with ./stop_app.sh.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HOME/miniconda3/envs/ild-ohif/bin/python"
LOG_DIR="$REPO_DIR/radiology/logs"
mkdir -p "$LOG_DIR"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [ "$(uname)" = "Darwin" ]; then
  echo "==> Colima"
  colima status >/dev/null 2>&1 || colima start
fi

echo "==> Orthanc (port 8042)"
if docker inspect orthanc >/dev/null 2>&1; then
  docker start orthanc >/dev/null
else
  docker run -d --name orthanc -p 8042:8042 -p 4242:4242 \
    -e DICOM_WEB_PLUGIN_ENABLED=true -e ORTHANC__AUTHENTICATION_ENABLED=false \
    orthancteam/orthanc
fi

echo "==> MONAI Label server (port 8000)"
if listening 8000; then
  echo "    already running"
else
  [ -x "$PY" ] || { echo "ERROR: $PY not found — run the setup script first." >&2; exit 1; }
  cd "$REPO_DIR"
  nohup "$PY" -m monailabel.main start_server --app radiology \
    --studies http://localhost:8042/dicom-web \
    --conf models nnunet_lung,nnunet_ild,sam2_ild \
    >"$LOG_DIR/monailabel_server.log" 2>&1 &
  echo "    log: $LOG_DIR/monailabel_server.log"
fi

echo "==> OHIF v3 viewer dev server (port 3002)"
if listening 3002; then
  echo "    already running"
elif ! command -v npx >/dev/null; then
  echo "    skipped: Node/npx not found (the built viewer is still served at http://localhost:8000/ohif/)"
else
  cd "$REPO_DIR/plugins/ohifv3/Viewers/platform/app"
  NODE_ENV=development PROXY_TARGET=/proxy/dicom PROXY_DOMAIN=http://localhost:8000 \
    PROXY_PATH_REWRITE_FROM=/proxy/dicom PROXY_PATH_REWRITE_TO=/proxy/dicom \
    APP_CONFIG=config/monai_label.js OHIF_PORT=3002 \
    nohup npx webpack-dev-server --config .webpack/webpack.pwa.js \
    >"$LOG_DIR/ohifv3_dev.log" 2>&1 &
  echo "    log: $LOG_DIR/ohifv3_dev.log"
fi

echo ""
echo "Starting up (models take ~1 min to load). Follow progress with:"
echo "  tail -f $LOG_DIR/*.log"
echo "Then browse to http://localhost:3002/ohif/ (dev) or http://localhost:8000/ohif/ (built)."
