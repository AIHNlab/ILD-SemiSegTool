# ILD SemiSeg Tool - server deployment

Runs the whole tool on one server PC with Docker or Podman (rootless works). Users open one web
address, log in, and land in the OHIF viewer with their own study list.
They add studies with **Upload** on the study list, and log out from the
settings (gear) menu, which shows who is logged in.

## What runs

| Container | What it does |
|---|---|
| `gateway` | The one web address: login check, the OHIF viewer, and routing to everything below |
| `login` | Login page and accounts (`data/login/users.json`, passwords hashed) |
| `monailabel` | AI models (nnU-Net, MedSAM2) on the GPU, or the CPU if there is none. One shared process; runs take turns |
| `orthanc-<user>` | Each user's own study store (`data/orthanc/<user>/`). Created per account |

Each user only ever sees their own studies, from any device they log in on.
Nothing except the gateway is reachable from the network.

## First-time setup

Requirements: Podman or Docker, plus the NVIDIA driver and toolkit for a GPU
(install steps per OS in the [main README](../README.md#installation)) and the
model weights in `backend/model/` (see [Model weights](../README.md#model-weights)). An NVIDIA GPU is optional: `GPU=auto` in `.env` uses one when the
container engine can reach it, otherwise the AI runs on the CPU.
`./manage.sh init`/`build`/`up` print which one is in use, and
`./manage.sh check-gpu` lists exactly what to install if the GPU isn't usable yet.

```bash
cd docker
./manage.sh init             # creates .env - open it and check address and ports
./manage.sh build            # builds the images (first time takes a while)
./manage.sh add-user alice --admin
./manage.sh up
```

Then open `http://<server>:8080/` (or whatever `.env` says) and log in.
Use Chrome, Edge or Safari - Firefox renders the images grey.

## Everyday admin

```bash
./manage.sh add-user bob          # new account + their own study store
./manage.sh passwd bob            # reset a password (logs them out everywhere)
./manage.sh remove-user bob       # remove the login; studies stay on disk
./manage.sh list-users
./manage.sh status                # all containers + GPU use
./manage.sh check-gpu             # GPU usable? if not, the commands to install what's missing
./manage.sh clean                 # remove stale scan caches and old images (up does this too)
./manage.sh backup                # archive accounts, studies, saves and .env into backups/
./manage.sh restore backups/ild-backup-YYYYMMDD-HHMM.tar.gz   # roll back to a backup
./manage.sh up                    # apply .env changes / restart after an update
```

After pulling code changes: `./manage.sh build && ./manage.sh up`. Changes
that only touch `backend/` (the AI backend code) just need
`./manage.sh restart monailabel`. Edits to `gateway/app-config.js` (viewer
settings, settings-menu items) need `./manage.sh restart gateway`.

Users who need to delete a study can do it in their own Orthanc page at
`http://<server>:8080/orthanc/ui/app/`.

## When a user reports a problem

```bash
./manage.sh user-logs bob         # last 24h: their requests (errors marked), AI runs, logins, their Orthanc
./manage.sh user-logs bob 2h      # narrower window
./manage.sh logs monailabel       # follow the AI backend live (model errors show here)
./manage.sh progress              # watch AI runs live, with progress bars (Ctrl-C stops watching)
```

| Symptom | Where to look |
|---|---|
| Can't log in | `user-logs NAME` → "Login attempts" (wrong password vs. no such user). `list-users` to check the name. `passwd NAME` to reset. |
| Study list empty / images don't load | `user-logs NAME` → gateway lines with errors; check `orthanc-NAME` is running in `status`. |
| AI run fails or hangs | `user-logs NAME` → "MONAI Label" lines, then `logs monailabel` for the full error. A long run may just be waiting for another user's run (one run at a time), or running on CPU (minutes per run). |
| Everything is down | `status`, then `logs gateway`. `up` restarts whatever stopped. |
| AI runs slowly / `up` says `AI backend: CPU` on a GPU machine | `./manage.sh check-gpu` - usually the toolkit isn't connected to the engine (step 3 of [NVIDIA GPU](../README.md#nvidia-gpu-linux-and-wsl)). After fixing: `./manage.sh build && ./manage.sh up`. |
| `monailabel` keeps restarting | `logs monailabel`. Usually missing weights in `backend/model/` (`./manage.sh check-models`), or too little memory for Docker (Docker Desktop → Settings → Resources). |

## Settings (`.env`)

All settings are in `.env` (documented in `.env.example`): the address and
HTTPS mode, ports, which models to load, how long a
login lasts, and where data is stored. Back up the `DATA_DIR` folder (or
use `./manage.sh backup`).

## Docker or Podman

`ENGINE=auto` (in `.env`) uses Docker if it is running, otherwise Podman;
set `docker` or `podman` to force one. Everything in `manage.sh` works the same
on both. Podman differences, handled by `manage.sh`:

- GPU: `docker-compose.podman-gpu.yml` (CDI device `nvidia.com/gpu=all`)
  instead of `docker-compose.gpu.yml`.
- Start at boot: `up` enables the user services `podman.socket` and
  `podman-restart.service`, and lingering (or tells you to ask the admin).
- Rootless: files in `data/` belong to your own user - no root needed to
  copy or delete them.
- Ubuntu: AppArmor won't let Podman stop its default network helper (pasta),
  so `manage.sh` switches your user's Podman to `slirp4netns` once (written to
  `~/.config/containers/containers.conf`).

## Disk space

`./manage.sh up` (or `clean`) removes what's safe to lose: AI image caches - a
converted copy of every scan anyone opened, ~0.5 GB each - not used for
`CACHE_DAYS` days (default 14; re-downloaded from the user's Orthanc in 10-20 s
when opened again), untagged images left by rebuilds, stopped containers, and
the CPU/GPU variant of the AI image not in use. Container logs are capped at
50 MB each. Accounts, studies and saved segmentations are never touched.

Moving an existing Docker install to Podman: `./manage.sh down`, then
`docker save ild-monailabel:cu130 ild-gateway ild-login | podman load` (or
`./manage.sh build`), hand `data/` to your user if Docker wrote it as root,
set `ENGINE=podman`, `./manage.sh up`.

## Backup and restore

`./manage.sh backup` writes one `.tar.gz` into `backups/` with everything
needed to rebuild the server: accounts and the login key, every user's studies
(Orthanc), their saved segmentations, and `.env`. The study stores pause for
the few seconds it takes. Size is roughly the stored size of all uploaded
studies (CT barely compresses further); each save adds ~1 MB. The AI
backend's image caches are left out - they are re-downloaded from Orthanc.
Copy backups off the server too (another disk or machine).

`./manage.sh restore FILE` replaces all current data with the backup: it asks
you to type `restore`, stops everything, moves the current data aside to
`data.before-restore-<time>/` (so you can go back), unpacks, and starts again.
The backup's settings are put next to `.env` as `.env.from-backup`; the
current `.env` stays in use.

**Moving to a new machine:** clone the repo and copy the backup over. Then, in
`docker/`:

```bash
tar -xzf /path/to/ild-backup-....tar.gz .env   # the old settings become .env
# copy the model weights into ../backend/model/ (not in the backup); edit .env if the address differs
./manage.sh build
./manage.sh restore /path/to/ild-backup-....tar.gz
```

## Security notes

- Use HTTPS for anything beyond a quick test (`SITE_ADDRESS` in `.env`).
- Don't expose the server to the internet without a VPN or your IT
  department's approval - it holds patient images.
- Sessions last `SESSION_HOURS`; changing a password ends all of that
  user's sessions.
