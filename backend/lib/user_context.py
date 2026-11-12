"""Per-request user identity for the multi-user (docker/) setup.

The gateway (docker/gateway/Caddyfile) only forwards a request to MONAI Label after
the login service has confirmed the session, and it then sets X-User to the
logged-in username (overwriting anything the browser sent). This module
wraps MONAI Label's ASGI app - started via
`monailabel.main start_server --uvicorn_app lib.user_context:app` - so every
request runs with that username in `current_user`, which MyApp.datastore()
(main.py) uses to pick that user's own Orthanc and cache folder.

Requests without a valid X-User are rejected outright, so MONAI Label never
serves anyone's data to an unauthenticated caller. In a plain local run
(a single-user `monailabel start_server`, no gateway) this module isn't loaded at all.
"""

import contextvars
import json
import logging
import re
import time

logger = logging.getLogger("ild.requests")

current_user: contextvars.ContextVar = contextvars.ContextVar("current_user", default=None)

# Usernames end up in container hostnames (orthanc-<user>) and folder names,
# so only allow a safe, simple character set - the login service enforces
# the same rule when accounts are created.
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def _user_from_scope(scope):
    for name, value in scope.get("headers", []):
        if name == b"x-user":
            user = value.decode("latin-1").strip()
            return user if USERNAME_RE.match(user) else None
    return None


async def _json(send, code, data):
    body = json.dumps(data).encode()
    await send(
        {
            "type": "http.response.start",
            "status": code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"cache-control", b"no-store"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _saved_label_rle(scope, send, user):
    """GET /datastore/label/rle?label=<image id>&tag=<tag>: one of the user's
    saved segmentations, run-length encoded (lib/label_upload.py), with its
    size and metadata (classes, model, ...) as JSON in the X-Label-Meta header.
    The viewer's Load uses this instead of the .nrrd file itself."""
    from urllib.parse import parse_qs

    import anyio

    query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
    label, tag = (query.get("label") or [""])[0], (query.get("tag") or [""])[0]

    def work():
        from monailabel.interfaces.utils.app import app_instance

        from lib.label_upload import saved_label_rle

        token = current_user.set(user)  # picks this user's own datastore
        try:
            uri = app_instance().datastore().get_label_uri(label, tag) if label and tag else ""
            return saved_label_rle(uri) if uri and uri.endswith(".nrrd") else None
        finally:
            current_user.reset(token)

    try:
        found = await anyio.to_thread.run_sync(work)
    except Exception as e:
        logger.exception(f"user={user} GET /datastore/label/rle failed")
        await _json(send, 500, {"detail": f"Could not read the saved segmentation: {e}"})
        return
    if not found:
        await _json(send, 404, {"detail": "No such saved segmentation"})
        return
    body, meta = found
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [
                (b"content-type", b"application/octet-stream"),
                (b"content-length", str(len(body)).encode()),
                (b"cache-control", b"no-store"),
                # ASCII-only JSON, so any class name is a valid header value.
                (b"x-label-meta", json.dumps(meta, ensure_ascii=True).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
    logger.info(f"user={user} GET /datastore/label/rle tag={tag} -> 200 ({len(body)} bytes)")


async def _reject(send):
    await _json(send, 401, {"detail": "Not logged in"})


def wrap(inner):
    async def app(scope, receive, send):
        if scope["type"] != "http":  # lifespan/websocket: pass through untouched
            await inner(scope, receive, send)
            return
        user = _user_from_scope(scope)
        if user is None:
            await _reject(send)
            return
        if scope["path"].startswith("/run-status/"):
            # Polled every second while a run is pending - answered here, unlogged.
            from lib import run_queue

            await _json(send, 200, run_queue.status(scope["path"][len("/run-status/"):]))
            return
        if scope["path"] == "/datastore/label/rle" and scope["method"] == "GET":
            await _saved_label_rle(scope, send, user)
            return
        status = {}

        async def send_logged(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        token = current_user.set(user)
        start = time.monotonic()
        try:
            await inner(scope, receive, send_logged)
        finally:
            current_user.reset(token)
            # One line per request, so a user's problem can be found with
            # `./manage.sh user-logs <user>` (or grep "user=<name>").
            logger.info(
                f"user={user} {scope['method']} {scope['path']} -> {status.get('code', 'no response')} "
                f"in {time.monotonic() - start:.1f}s"
            )

    return app


def _load():
    from monailabel.app import app as monailabel_app

    return wrap(monailabel_app)


app = _load()
