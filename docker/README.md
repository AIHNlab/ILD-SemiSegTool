# ILD SemiSeg Tool - server deployment

Runs the whole tool on one server PC with Docker. Users open one web
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

Requirements: Docker (see the [main README](../README.md#quick-start-docker)
for Windows/macOS/Linux) and the model weights. An NVIDIA GPU is optional:
`GPU=auto` in `.env` uses one when Docker can reach it, otherwise the AI runs
on the CPU. `./manage.sh init`/`build`/`up` print which one is in use.

```bash
cd docker
./manage.sh init             # creates .env - open it and check address, ports, model paths
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
./manage.sh backup                # archive accounts, studies and saves into backups/
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
```

| Symptom | Where to look |
|---|---|
| Can't log in | `user-logs NAME` → "Login attempts" (wrong password vs. no such user). `list-users` to check the name. `passwd NAME` to reset. |
| Study list empty / images don't load | `user-logs NAME` → gateway lines with errors; check `orthanc-NAME` is running in `status`. |
| AI run fails or hangs | `user-logs NAME` → "MONAI Label" lines, then `logs monailabel` for the full error. A long run may just be waiting for another user's run (one run at a time), or running on CPU (minutes per run). |
| Everything is down | `status`, then `logs gateway`. `up` restarts whatever stopped. |
| `monailabel` keeps restarting | `logs monailabel`. Usually a wrong weight path in `.env`, or too little memory for Docker (Docker Desktop → Settings → Resources). |

## Settings (`.env`)

All settings are in `.env` (documented in `.env.example`): the address and
HTTPS mode, ports, model weight paths, which models to load, how long a
login lasts, and where data is stored. Back up the `DATA_DIR` folder (or
use `./manage.sh backup`).

## Security notes

- Use HTTPS for anything beyond a quick test (`SITE_ADDRESS` in `.env`).
- Don't expose the server to the internet without a VPN or your IT
  department's approval - it holds patient images.
- Sessions last `SESSION_HOURS`; changing a password ends all of that
  user's sessions.
