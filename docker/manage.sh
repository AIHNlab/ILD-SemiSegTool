#!/usr/bin/env bash
# Admin tool for the ILD SemiSeg Tool. Run `./manage.sh help`.
# Works on Linux, macOS (bash 3.2) and Windows (Git Bash or WSL), with Docker or
# Podman (e.g. rootless, on a server without admin rights).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

USERS_FILE=users.generated.yml

die() { echo "Error: $*" >&2; exit 1; }
need_env() { [ -f .env ] || die "no .env yet - run ./manage.sh init first"; }
# Value of KEY in .env (quotes stripped), or $2 if unset.
env_get() { local v; v=$(sed -n "s/^$1=//p" .env | tail -n 1 | tr -d "\"'\r"); echo "${v:-${2:-}}"; }
# Sets KEY=VALUE in .env (replacing or appending), without sed -i (differs on macOS).
env_set() {
  awk -v k="$1" -v v="$2" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' .env > .env.tmp
  mv .env.tmp .env
}
data_dir() { env_get DATA_DIR ./data; }
# Absolute path of a directory, in the form `docker run -v` accepts (C:/... on Git Bash).
abs_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }

# Container engine: ENGINE=auto|docker|podman in .env. auto = Docker if its service
# answers, else Podman. Every container command below goes through ctr / compose.
E=""
init_engine() {
  local want=auto
  [ -f .env ] && want=$(env_get ENGINE auto)
  case "$want" in
    docker | podman) E=$want ;;
    *)
      if docker info >/dev/null 2>&1; then E=docker
      elif command -v podman >/dev/null 2>&1; then E=podman
      else die "neither Docker nor Podman is available - install one (see README)"; fi ;;
  esac
  if [ "$E" = podman ]; then
    # `podman compose` runs docker-compose against Podman's API socket. Use the
    # docker-compose program explicitly (podman-compose lacks flags used here).
    local p
    for p in "$HOME/.docker/cli-plugins/docker-compose" "$(command -v docker-compose 2>/dev/null || true)" \
      /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose \
      /usr/lib/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-compose; do
      if [ -n "$p" ] && [ -x "$p" ]; then export PODMAN_COMPOSE_PROVIDER="$p"; break; fi
    done
    if [ -z "${PODMAN_COMPOSE_PROVIDER:-}" ]; then
      echo "Error: Podman needs the docker-compose program. Install it for your user (no admin rights needed):" >&2
      echo "  mkdir -p ~/.docker/cli-plugins" >&2
      echo "  curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-\$(uname -m) \\" >&2
      echo "    -o ~/.docker/cli-plugins/docker-compose && chmod +x ~/.docker/cli-plugins/docker-compose" >&2
      exit 1
    fi
    export PODMAN_COMPOSE_WARNING_LOGS=false
    podman_network_fix
    systemctl --user is-active --quiet podman.socket 2>/dev/null \
      || systemctl --user enable --now podman.socket >/dev/null 2>&1 \
      || die "could not start Podman's API socket - run: systemctl --user enable --now podman.socket"
  fi
}
# Ubuntu's AppArmor profile for pasta (rootless Podman's default network helper)
# refuses Podman's stop signal, so removing the last container fails with
# "rootless netns: kill network process: permission denied". Use slirp4netns
# instead - a per-user Podman setting, no admin rights needed.
podman_network_fix() {
  local conf="${XDG_CONFIG_HOME:-$HOME/.config}/containers/containers.conf"
  [ -e /etc/apparmor.d/usr.bin.pasta ] || return 0
  grep -qs 'default_rootless_network_cmd' "$conf" && return 0
  if ! command -v slirp4netns >/dev/null 2>&1; then
    echo "Warning: Ubuntu's AppArmor blocks Podman from stopping its network helper (pasta)."
    echo "  Ask the admin to install slirp4netns: sudo apt-get install -y slirp4netns"
    return 0
  fi
  if grep -qs '^\[network\]' "$conf"; then
    echo "Warning: add  default_rootless_network_cmd = \"slirp4netns\"  under [network] in $conf"
    return 0
  fi
  mkdir -p "$(dirname "$conf")"
  printf '%s\n' "" "# Added by the ILD SemiSeg Tool (docker/manage.sh): Ubuntu's AppArmor stops" \
    "# Podman from stopping pasta, so use slirp4netns for rootless networking." \
    "[network]" 'default_rootless_network_cmd = "slirp4netns"' >> "$conf"
  systemctl --user restart podman.service >/dev/null 2>&1 || true
  echo "Podman: switched rootless networking to slirp4netns (in $conf)."
}
ctr() { "$E" "$@"; }
# Under Podman, docker-compose is run directly against Podman's socket (what
# `podman compose` does too, minus its extra "Error: executing ..." line).
compose() {
  if [ "$E" = podman ]; then
    DOCKER_HOST="unix://${PODMAN_SOCKET:=$(podman info --format '{{.Host.RemoteSocket.Path}}')}" "$PODMAN_COMPOSE_PROVIDER" "$@"
  else docker compose "$@"; fi
}
ALPINE=docker.io/library/alpine:3.20
# Files a helper container creates: rootful Docker writes them as root, so hand
# them to the current user. (Rootless Podman's root already is the current user.)
chown_cmd() { [ "$E" = docker ] && echo "&& chown $(id -u):$(id -g) $1" || true; }

# Podman has no always-running service: containers come back after a reboot via
# the user's podman-restart service, and only if the user may "linger".
podman_boot() {
  [ "$E" = podman ] || return 0
  systemctl --user enable podman.socket podman-restart.service >/dev/null 2>&1 \
    || echo "Warning: could not enable podman-restart.service - containers won't start after a reboot."
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    if loginctl enable-linger "$(id -un)" 2>/dev/null; then
      echo "Enabled lingering: the site keeps running after you log out and starts after a reboot."
    else
      echo "Note: ask the server admin to run 'loginctl enable-linger $(id -un)' - until then"
      echo "      the site stops when you log out and doesn't start after a reboot."
    fi
  fi
}

# NEW_PASSWORD (optional) sets the password without a prompt, e.g. for scripted setup.
login_cli() { compose run --rm --no-deps ${NEW_PASSWORD:+-e NEW_PASSWORD} login python app.py "$@"; }

# ---- NVIDIA GPU check: what's missing, with the commands to install it ----
os_kind() { # mac | windows | wsl | linux-apt | linux-dnf | linux-other
  case "$(uname -s)" in
    Darwin) echo mac; return ;;
    MINGW* | MSYS* | CYGWIN*) echo windows; return ;;
  esac
  if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl
  elif command -v apt-get >/dev/null 2>&1; then echo linux-apt
  elif command -v dnf >/dev/null 2>&1; then echo linux-dnf
  else echo linux-other; fi
}
# NVIDIA card present? PCI vendor 0x10de, class 0x03 (display) - works before any
# driver is installed. Windows/WSL have no PCI list here; their driver is the sign.
has_nvidia_hw() {
  local d
  for d in /sys/bus/pci/devices/*; do
    if [ "$(cat "$d/vendor" 2>/dev/null)" = 0x10de ]; then
      case "$(cat "$d/class" 2>/dev/null)" in 0x03*) return 0 ;; esac
    fi
  done
  command -v nvidia-smi >/dev/null 2>&1 || command -v nvidia-smi.exe >/dev/null 2>&1 || [ -e /usr/lib/wsl/lib/nvidia-smi ]
}
driver_ok() { nvidia-smi -L >/dev/null 2>&1 || nvidia-smi.exe -L >/dev/null 2>&1 || /usr/lib/wsl/lib/nvidia-smi -L >/dev/null 2>&1; }
toolkit_ok() { command -v nvidia-ctk >/dev/null 2>&1; }
# Podman finds the GPU through a CDI spec file (generated by the toolkit).
cdi_ok() { grep -qs 'nvidia.com/gpu' /etc/cdi/* /var/run/cdi/*; }
cdi_refresh_ok() { systemctl is-enabled --quiet nvidia-cdi-refresh.path 2>/dev/null; }
gpu_container_ok() {
  local flag="--gpus all"
  [ "$E" = podman ] && flag="--device nvidia.com/gpu=all"
  ctr run --rm $flag $ALPINE true >/dev/null 2>&1
}

# Prints the GPU status and, if an NVIDIA GPU can't be used yet, the install
# commands for this OS and engine. Returns 0 = ready, 1 = no NVIDIA GPU, 2 = fixable.
gpu_report() {
  local os n=0
  os=$(os_kind)
  step() { n=$((n + 1)); echo; echo "$n. $1"; }
  echo "== NVIDIA GPU check =="
  if [ "$os" = mac ]; then echo "macOS has no NVIDIA GPU support - the AI runs on the CPU."; return 1; fi
  if ! has_nvidia_hw; then echo "No NVIDIA GPU in this machine - the AI runs on the CPU."; return 1; fi
  if gpu_container_ok; then
    echo "OK: the NVIDIA GPU is ready for $E."
    if [ "$E" = podman ] && ! grep -qs 'nvidia.com/gpu' /etc/cdi/* && ! cdi_refresh_ok; then
      echo "Note: the GPU description is in /var/run/cdi, which is cleared at reboot. To keep it, an admin runs:"
      echo "   sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service"
    fi
    return 0
  fi

  echo "An NVIDIA GPU is in this machine, but $E can't use it yet - the AI would run on the"
  echo "CPU (minutes instead of seconds). Install what's missing below, in order. These need"
  echo "admin rights (sudo) - without them, send this list to your IT."

  if ! driver_ok; then
    step "NVIDIA driver (not installed or not working)"
    case "$os" in
      linux-apt)
        if command -v ubuntu-drivers >/dev/null 2>&1; then echo "   sudo ubuntu-drivers install"
        else echo "   sudo apt-get install -y nvidia-driver    # Debian: needs 'non-free' in apt sources"; fi
        echo "   sudo reboot" ;;
      linux-dnf)
        echo "   Follow https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/ (RHEL/Rocky)"
        echo "   or on Fedora: sudo dnf install akmod-nvidia   # from RPM Fusion"
        echo "   then: sudo reboot" ;;
      wsl | windows)
        echo "   Install the NVIDIA driver for Windows: https://www.nvidia.com/Download/index.aspx"
        echo "   (WSL uses the Windows driver - never install one inside WSL), then restart Windows." ;;
      *) echo "   https://www.nvidia.com/Download/index.aspx, then reboot" ;;
    esac
  fi

  # Docker Desktop (Windows, or WSL using it) brings its own GPU support. Podman or
  # Docker Engine installed inside WSL need the toolkit in WSL, like Linux.
  if [ "$os" = windows ] || { [ "$os" = wsl ] && [ "$E" = docker ] \
      && docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -q "Docker Desktop"; }; then
    step "Docker Desktop: Settings -> General -> 'Use the WSL 2 based engine' must be on."
    echo; echo "Then run ./manage.sh check-gpu again."
    return 2
  fi

  if ! toolkit_ok; then
    step "NVIDIA Container Toolkit (lets containers use the GPU)"
    case "$os" in
      linux-apt | wsl) cat <<'EOF'
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
     | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
   curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
     | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
     | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
   sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
EOF
        ;;
      linux-dnf) cat <<'EOF'
   curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
     | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
   sudo dnf install -y nvidia-container-toolkit
EOF
        ;;
      *) echo "   https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html" ;;
    esac
  fi

  if [ "$E" = docker ]; then
    step "Connect the toolkit to Docker"
    echo "   sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
  elif [ "$os" = wsl ] && { ! toolkit_ok || ! cdi_ok; }; then
    step "Describe the GPU for Podman (CDI) - WSL variant, detected automatically"
    echo "   sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml"
    echo "   # re-run it after updating the NVIDIA driver on Windows"
  elif ! toolkit_ok || ! cdi_ok; then
    step "Describe the GPU for Podman (CDI) - kept up to date across reboots and driver updates"
    echo "   sudo systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service"
    echo "   # toolkit older than 1.18 (no such service): sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml"
    echo "   #   and re-run that after every driver update"
  else
    step "Driver, toolkit and GPU description are all there, but a test container still can't use the GPU."
    echo "   See the error: $E run --rm --device nvidia.com/gpu=all $ALPINE true"
  fi
  echo
  echo "Then run ./manage.sh check-gpu again; once it says OK: ./manage.sh build && ./manage.sh up"
  echo "(build is needed once: the AI image for the GPU differs from the CPU one.)"
  return 2
}
# ---- end NVIDIA GPU check ----

# GPU=auto|yes|no in .env -> which compose files and torch build to use.
# The result is written back into .env (COMPOSE_FILE, TORCH_VARIANT) so plain
# `compose ...` commands behave the same as manage.sh.
resolve_gpu() {
  local want use gpu_file
  want=$(env_get GPU auto)
  case "$want" in
    yes) use=yes ;;
    no) use=no ;;
    *)
      if gpu_container_ok; then use=yes; else use=no; fi ;;
  esac
  if [ "$use" = yes ]; then
    # Docker asks for the GPU as `gpus: all`; Podman by its CDI name.
    if [ "$E" = podman ]; then gpu_file=docker-compose.podman-gpu.yml; else gpu_file=docker-compose.gpu.yml; fi
    env_set COMPOSE_FILE "docker-compose.yml:$gpu_file:$USERS_FILE"
    env_set TORCH_VARIANT cu130
    echo "AI backend: NVIDIA GPU"
  else
    env_set COMPOSE_FILE "docker-compose.yml:$USERS_FILE"
    env_set TORCH_VARIANT cpu
    echo "AI backend: CPU (no NVIDIA GPU available to $E - AI runs take minutes instead of seconds)"
    if [ "$want" != no ] && [ -z "${QUIET_GPU_HINT:-}" ] && [ "$(os_kind)" != mac ] && has_nvidia_hw; then
      echo
      echo "  !! WARNING: this machine has an NVIDIA GPU, but $E can't use it, so the AI"
      echo "  !! will run on the CPU (4-5x slower). Usually a skipped setup step:"
      echo "  !!   ./manage.sh check-gpu        shows which one, with the commands"
      echo "  !!   then: ./manage.sh build && ./manage.sh up"
      echo "  !! CPU on purpose? Set GPU=no in .env to hide this."
      echo
    fi
  fi
  env_set COMPOSE_PATH_SEPARATOR ":"
}
gpu_mode() { case "$(env_get COMPOSE_FILE)" in *gpu*) echo yes ;; *) echo no ;; esac; }

# Removes what is safe to lose (run by `up`, or `./manage.sh clean`): AI image
# caches not used for CACHE_DAYS days (re-downloaded from Orthanc when opened
# again), stopped containers of this tool, untagged images left by rebuilds, and
# the AI image variant (cpu/cu130) not in use. Never touches accounts, studies,
# saved segmentations, or the base images the next build reuses.
clean_up() {
  local days d n variant other
  days=$(env_get CACHE_DAYS 14); d=$(data_dir)
  # Per user cache folder: <series UID>.nii.gz (read on every AI run, so its access
  # time = last use) + <series UID>/ (the DICOM copy it was made from). Folder
  # times are useless here - any listing (e.g. a backup) touches them. A DICOM
  # folder without .nii.gz (interrupted download) goes by its own date. Runs in a
  # container: under Docker these files are root-owned. (busybox find ignores -atime.)
  n=0
  if [ -d "$d/monailabel/users" ]; then
    n=$(MSYS_NO_PATHCONV=1 ctr run --rm -v "$(abs_path "$d/monailabel/users"):/u" $ALPINE sh -c '
      now=$(date +%s); max=$(('"$days"' * 86400)); n=0
      for f in /u/*/*/[0-9]*.nii.gz; do
        [ -e "$f" ] || continue
        if [ $((now - $(stat -c %X "$f"))) -gt $max ]; then rm -rf "$f" "${f%.nii.gz}"; n=$((n + 1)); fi
      done
      for f in /u/*/*/[0-9]*; do
        [ -d "$f" ] && [ ! -e "$f.nii.gz" ] || continue
        if [ $((now - $(stat -c %Y "$f"))) -gt $max ]; then rm -rf "$f"; n=$((n + 1)); fi
      done
      echo $n' 2>/dev/null | tr -d ' \r' || echo 0)
  fi
  ctr container prune -f --filter label=com.docker.compose.project=ild-semiseg >/dev/null 2>&1 || true
  ctr image prune -f >/dev/null 2>&1 || true
  if [ "$E" = docker ]; then docker builder prune -f >/dev/null 2>&1 || true; fi
  variant=$(env_get TORCH_VARIANT cpu); other=cpu
  [ "$variant" = cpu ] && other=cu130
  ctr image rm "ild-monailabel:$other" >/dev/null 2>&1 || true
  echo "Cleaned up: ${n:-0} cached scan file(s) unused for $days+ days, old images and stopped containers."
}

# Checks the model weights in backend/model/ (always there - mounted into the AI
# container as /app/backend/model) for the models in MODELS, so a missing file is
# reported with its real path instead of the AI backend failing on a path inside
# its container. Suggests a fix for common mix-ups; returns 1 if anything is missing.
MODEL_DIR=../backend/model
check_models() {
  local r="$MODEL_DIR/nnUNet_results" sam="$MODEL_DIR/sam2/checkpoint_ild.pt" models n=0 d f
  models=",$(env_get MODELS),"
  bad() { n=$((n + 1)); echo "  - $*"; }
  nn() { # model, dataset folder
    case "$models" in *",$1,"*) ;; *) return 0 ;; esac
    d="$r/$2/nnUNetTrainer__nnUNetPlans__3d_fullres"
    for f in plans.json dataset.json fold_0/checkpoint_final.pth; do
      [ -f "$d/$f" ] || bad "$1: missing backend/model/nnUNet_results/$2/nnUNetTrainer__nnUNetPlans__3d_fullres/$f"
    done
  }
  case "$models" in *,nnunet_*)
    # A link pointing outside backend/model can't be followed inside the container.
    if [ -L "$r" ]; then
      bad "backend/model/nnUNet_results is a link (to $(readlink "$r")) - the container can't follow it; move the folder itself here"
    fi
    nn nnunet_lung Dataset001_Lung
    nn nnunet_ild Dataset003_ILD_raw
    case "$models" in *,nnunet_airways,*)
      [ -f "$r/Dataset005_Airways/airways.pth" ] || bad "nnunet_airways: missing backend/model/nnUNet_results/Dataset005_Airways/airways.pth" ;;
    esac
    if [ "$n" -gt 0 ] && [ ! -L "$r" ]; then
      if d=$(find "$MODEL_DIR" -mindepth 1 -maxdepth 4 -type d -name 'Dataset00[0-9]_*' 2>/dev/null | head -n 1) && [ -n "$d" ] && [ "$(dirname "$d")" != "$r" ]; then
        echo "    -> the Dataset folders are in $(dirname "$d") - move them into backend/model/nnUNet_results/"
      fi
    fi ;;
  esac
  case "$models" in *,sam2_ild,*)
    if [ -L "$sam" ]; then
      bad "backend/model/sam2/checkpoint_ild.pt is a link (to $(readlink "$sam")) - put the file itself there"
    elif [ ! -f "$sam" ]; then
      bad "sam2_ild: missing backend/model/sam2/checkpoint_ild.pt (the MedSAM2 checkpoint, renamed to this)"
      if d=$(ls "$MODEL_DIR"/sam2/*.pt 2>/dev/null | head -n 1) && [ -n "$d" ]; then
        echo "    -> found $d - rename it: mv \"$d\" $sam"
      fi
    fi ;;
  esac
  [ "$n" -eq 0 ] && { echo "Model weights: OK ($(env_get MODELS))"; return 0; }
  cat <<'EOF'
  Expected in the repo's backend/model/ folder:
    nnUNet_results/
      Dataset001_Lung/nnUNetTrainer__nnUNetPlans__3d_fullres/     (nnunet_lung)
      Dataset003_ILD_raw/nnUNetTrainer__nnUNetPlans__3d_fullres/  (nnunet_ild)
          plans.json  dataset.json  fold_0/checkpoint_final.pth
      Dataset005_Airways/airways.pth                               (nnunet_airways)
    sam2/checkpoint_ild.pt                                         (sam2_ild)
  Copy the weights there, or remove models you don't have from MODELS= in .env.
EOF
  return 1
}

# The address users open, from SITE_ADDRESS/ports in .env. With plain HTTP the
# host is this machine: the IP an SSH session came in on (reachable from the
# admin's own computer), else localhost.
app_url() {
  local site port host
  site=$(env_get SITE_ADDRESS :80)
  case "$site" in
    :*)
      port=$(env_get HTTP_PORT 8080); host=localhost
      [ -n "${SSH_CONNECTION:-}" ] && host=$(echo "$SSH_CONNECTION" | awk '{print $3}')
      [ "$port" = 80 ] && echo "http://$host/" || echo "http://$host:$port/" ;;
    *)
      site=${site#https://}; site=${site%%/*}; port=$(env_get HTTPS_PORT 8443)
      [ "$port" = 443 ] && echo "https://$site/" || echo "https://$site:$port/" ;;
  esac
}

# Waits until the site answers, prints its address(es) and opens it in a browser:
# on the admin's own computer when in a VS Code remote terminal ($BROWSER), or on
# this machine's desktop. Nothing opens on a plain SSH session. OPEN_BROWSER=no
# in .env turns opening off.
show_url() {
  local url ip i opened=""
  url=$(app_url)
  for i in $(seq 30); do
    command -v curl >/dev/null 2>&1 || break
    curl -s -o /dev/null --max-time 2 -k "$url" 2>/dev/null && break
    sleep 1
  done
  echo
  echo "The app is at:  $url"
  case "$url" in
    http://localhost*)
      ip=$(hostname -I 2>/dev/null | awk '{print $1}')
      [ -n "$ip" ] && echo "From other devices: ${url/localhost/$ip}" ;;
  esac
  [ "$(env_get OPEN_BROWSER yes)" = no ] && return 0
  if [ -n "${BROWSER:-}" ]; then "$BROWSER" "$url" >/dev/null 2>&1 && opened=1
  elif [ "$(uname -s)" = Darwin ]; then open "$url" && opened=1
  elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$url" >/dev/null 2>&1 && opened=1
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 & opened=1
  fi
  [ -n "$opened" ] && echo "(opened in your browser)"
  return 0
}

# Writes one Orthanc service per account into users.generated.yml.
generate_users() {
  local users u  # u local: callers (add-user, remove-user) keep their own $u
  users=$(login_cli list | awk '{print $1}' | tr -d '\r')
  {
    echo "# GENERATED by manage.sh from the account list - do not edit by hand."
    if [ -n "$users" ]; then echo "services:"; else echo "services: {}"; fi
    for u in $users; do
      cat <<EOF
  orthanc-$u:
    image: \${ORTHANC_IMAGE:-docker.io/orthancteam/orthanc:latest}
    restart: always
    logging:
      options: { max-size: "50m" }
    labels:
      ild.user: "$u"
    environment:
      ORTHANC__NAME: "$u"
      ORTHANC__AUTHENTICATION_ENABLED: "false"
      DICOM_WEB_PLUGIN_ENABLED: "true"
      ORTHANC_JSON: '{"OrthancExplorer2": {"UiOptions": {"EnableOpenInOhifViewer3": true, "OhifViewer3PublicRoot": "/ohif/", "EnableLinkToLegacyUi": false}}}'
    volumes:
      - \${DATA_DIR:-./data}/orthanc/$u:/var/lib/orthanc/db
EOF
    done
  } > "$USERS_FILE.tmp"
  mv "$USERS_FILE.tmp" "$USERS_FILE"
}

cmd=${1:-help}
shift || true
case "$cmd" in help | -h | --help) ;; *) init_engine ;; esac
case "$cmd" in
  init)
    [ -f .env ] || { cp .env.example .env; echo "Created .env - review it (address, ports, models)."; }
    [ -f "$USERS_FILE" ] || echo "services: {}" > "$USERS_FILE"
    QUIET_GPU_HINT=1 resolve_gpu
    echo; gpu_report || true; echo
    check_models || echo "(Put the model weights in backend/model/ before ./manage.sh up.)"; echo
    echo "Next: ./manage.sh build, then ./manage.sh add-user <name> --admin, then ./manage.sh up"
    ;;
  clean)
    need_env; clean_up
    ;;
  check-models)
    need_env; check_models || exit 1
    ;;
  check-gpu)
    gpu_report || true
    ;;
  build)
    need_env; resolve_gpu; compose build "$@"
    ;;
  up | start)
    need_env; echo "Checking model weights..."; check_models || die "model weights missing - see above (nothing was started)"
    resolve_gpu; generate_users; compose up -d --remove-orphans
    podman_boot
    clean_up
    compose ps
    show_url
    ;;
  down | stop)
    need_env; compose down
    ;;
  restart)
    # Recreate rather than restart, so edited code files (e.g. backend/main.py) are picked up.
    need_env; compose up -d --force-recreate "$@"
    ;;
  status)
    need_env; compose ps
    echo
    if [ "$(gpu_mode)" = yes ]; then
      echo "GPU:"; nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null \
        || compose exec -T monailabel nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader || true
    else
      echo "AI backend runs on CPU."; ctr stats --no-stream $(compose ps -q monailabel) 2>/dev/null || true
    fi
    ;;
  logs)
    need_env; compose logs -f --tail=200 "$@"
    ;;
  progress)
    # Live AI output incl. progress bars. `logs` can't show these: they redraw one
    # line with \r and compose only prints complete lines. Ctrl-C only detaches.
    need_env; c=$(compose ps -q monailabel); [ -n "$c" ] || die "monailabel is not running"
    echo "Live AI backend output (progress bars appear while a run is active). Ctrl-C to stop watching."
    ctr attach --no-stdin --sig-proxy=false "$c"
    ;;
  user-logs)
    need_env; u=${1:?usage: user-logs NAME [SINCE, e.g. 2h]}; since=${2:-24h}
    echo "== Requests through the gateway (last $since; status >= 400 marked) =="
    compose logs --no-color --no-log-prefix --since "$since" gateway \
      | grep -F "\"user\":\"$u\"" | tail -n 40 \
      | sed -E 's/.*"ts":"([^"]+)".*"method":"([A-Z]+)".*"uri":"([^"]*)".*"status":([0-9]+).*/\1 \2 \3 -> \4/' \
      | awk '{ mark=($NF>=400)?"  <-- ERROR":""; print $0 mark }'
    echo; echo "== MONAI Label (AI) requests =="
    compose logs --no-color --no-log-prefix --since "$since" monailabel | grep -F "user=$u " | tail -n 40 || true
    echo; echo "== Login attempts =="
    compose logs --no-color --no-log-prefix --since "$since" login | grep -F "user=$u " | tail -n 20 || true
    echo; echo "== Their Orthanc (orthanc-$u) =="
    compose ps "orthanc-$u" 2>/dev/null || echo "orthanc-$u is not running"
    compose logs --no-color --no-log-prefix --since "$since" "orthanc-$u" 2>/dev/null | grep -iE "error|warn" | tail -n 20 || true
    ;;
  add-user)
    need_env; u=${1:?usage: add-user NAME [--admin]}
    login_cli add-user "$@"
    generate_users
    mkdir -p "$(data_dir)/orthanc/$u"
    compose up -d "orthanc-$u"
    echo "User '$u' can now log in."
    ;;
  passwd)
    need_env; login_cli passwd "${1:?usage: passwd NAME}"
    ;;
  remove-user)
    need_env; u=${1:?usage: remove-user NAME}
    compose rm -sf "orthanc-$u" || true
    login_cli remove-user "$u"
    generate_users
    echo "Removed '$u'. Their studies are kept in $(data_dir)/orthanc/$u - delete that folder to erase them."
    ;;
  list-users)
    need_env; login_cli list
    ;;
  backup)
    need_env; d=$(data_dir); mkdir -p backups; name="ild-backup-$(date +%Y%m%d-%H%M).tar.gz"
    echo "Pausing the study stores briefly for a consistent copy..."
    orthancs=$(compose ps --services | grep '^orthanc-' || true)
    if [ -n "$orthancs" ]; then
      compose stop $orthancs
      # Restart them however this ends, even if the backup fails.
      trap 'echo "Restarting the study stores..."; compose start $orthancs >/dev/null' EXIT
    fi
    # The containers write their data as root, so archive it from a container
    # (as root) too, then hand the file to the current user. The AI backend's
    # image caches (*.dcm copies, *.nii.gz) are re-downloaded from Orthanc when
    # needed - Orthanc's own store (no .dcm names) holds the originals.
    # Archive layout: data/... plus .env (the settings, for rebuilding on a new
    # machine). Both are mounted under /src since busybox tar takes only one -C.
    MSYS_NO_PATHCONV=1 ctr run --rm \
      -v "$(abs_path "$d"):/src/data:ro" -v "$(abs_path .)/.env:/src/.env:ro" -v "$(abs_path backups):/backups" $ALPINE \
      sh -c "tar -czf /backups/$name.part --exclude='*.nii.gz' --exclude='*.dcm' -C /src data .env \
             && mv /backups/$name.part /backups/$name $(chown_cmd /backups/$name)" \
      || { rm -f "backups/$name.part"; die "backup failed - nothing was written"; }
    echo "Backup written: backups/$name ($(du -h "backups/$name" | cut -f1))"
    ;;
  restore)
    need_env; f=${1:?usage: restore BACKUP_FILE (e.g. backups/ild-backup-20261110-2226.tar.gz)}
    [ -f "$f" ] || die "no such file: $f"
    d=$(data_dir); stamp=$(date +%Y%m%d-%H%M%S); old="${d%/}.before-restore-$stamp"
    echo "This replaces ALL current data - accounts, studies, saved segmentations - with $f."
    echo "Everything is stopped meanwhile. The current data is kept in $old, in case you need it back."
    printf "Type 'restore' to continue: "; read -r ans
    [ "$ans" = restore ] || die "cancelled - nothing changed"
    compose down
    if [ -d "$d" ]; then mv "$d" "$old"; fi
    mkdir -p "$d"
    # Unpack as root (the containers' files are root-owned). The backup's settings
    # file is put aside as .env.from-backup - the current .env stays in use.
    # Older backups have the data at the top level instead of under data/.
    MSYS_NO_PATHCONV=1 ctr run --rm \
      -v "$(abs_path "$d"):/out/data" -v "$(abs_path "$(dirname "$f")"):/b:ro" -v "$(abs_path .):/cfg" $ALPINE \
      sh -c "F='/b/$(basename "$f")'; \
             if tar -tzf \"\$F\" | grep -q '^data/'; then tar -xzf \"\$F\" -C /out; else tar -xzf \"\$F\" -C /out/data; fi \
             && if [ -f /out/.env ]; then cp /out/.env /cfg/.env.from-backup $(chown_cmd /cfg/.env.from-backup); fi" \
      || die "unpacking failed - your previous data is untouched in $old (move it back to $d to undo)"
    echo "Restored. Starting everything..."
    "$0" up
    echo
    echo "Done. Check that logins, studies and saves look right, then delete the old copy:"
    echo "  $E run --rm -v \"$(abs_path "$(dirname "$old")")\":/p $ALPINE rm -rf \"/p/$(basename "$old")\""
    [ -f .env.from-backup ] && echo "The backup's settings are in .env.from-backup (only needed when moving to a new machine)."
    ;;
  help | *)
    cat <<'EOF'
Usage: ./manage.sh <command>

Setup
  init                      create .env from .env.example (edit it afterwards)
  build                     build the images (first time, or after code updates)
  up                        start / update everything
  down                      stop everything

Users
  add-user NAME [--admin]   create a login + that user's own study store
  passwd NAME               change a password (logs them out on all devices)
  remove-user NAME          remove a login (their studies stay on disk)
  list-users                show all accounts

Monitoring
  status                    containers + GPU (or CPU) use at a glance
  check-models              are the model weights in backend/model/ complete?
  check-gpu                 is the NVIDIA GPU usable? if not, what to install
  logs [SERVICE]            follow logs (gateway, login, monailabel, orthanc-NAME)
  progress                  watch AI runs live, with progress bars
  user-logs NAME [SINCE]    everything about one user's recent activity/errors
  restart [SERVICE]         restart one service (or all)
  clean                     remove stale caches/old images (also done by up)
  backup                    archive accounts, studies, saves and .env into backups/
  restore FILE              replace all data with a backup (current data is kept aside)
EOF
    ;;
esac
