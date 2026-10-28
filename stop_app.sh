#!/bin/bash
# Stops the OHIF dev viewer and MONAI Label server. Orthanc (and Colima on macOS)
# keep running since they hold your uploaded studies; pass --all to stop them too.
set -uo pipefail

stop_port() {
  local pids
  pids=$(lsof -tiTCP:"$2" -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pids" ]; then
    kill $pids && echo "==> $1 (port $2): stopped"
  else
    echo "==> $1 (port $2): not running"
  fi
}

stop_port "OHIF v3 dev viewer" 3002
stop_port "MONAI Label server" 8000

if [ "${1:-}" = "--all" ]; then
  docker stop orthanc >/dev/null 2>&1 && echo "==> Orthanc: stopped" || echo "==> Orthanc: not running"
  if [ "$(uname)" = "Darwin" ]; then colima stop; fi
else
  echo "Orthanc left running. Pass --all to stop it too."
fi
