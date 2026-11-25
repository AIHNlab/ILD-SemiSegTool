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
    The viewer's Load uses this instead of the .nrrd file itself.

    GET /datastore/label/merge-rle?label=<image id>&tags=<tag>,<tag>,...[&top=<tag>]:
    the same for several saves layered into one - largest underneath, or `top`
    on top (label_upload.merge_saved_labels); X-Label-Meta then also has "top",
    the tag that ended up on top. Used by the Load dialog's "Load selected
    together" and the panel's "Merged layers" switch."""
    from urllib.parse import parse_qs

    import anyio

    query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
    label, tag = (query.get("label") or [""])[0], (query.get("tag") or [""])[0]
    merge = scope["path"].endswith("/merge-rle")
    tags = [t for t in (query.get("tags") or [""])[0].split(",") if t] if merge else [tag]
    top_tag = (query.get("top") or [""])[0]

    def work():
        from monailabel.interfaces.utils.app import app_instance

        from lib.label_upload import merge_saved_labels, saved_label_rle

        token = current_user.set(user)  # picks this user's own datastore
        try:
            datastore = app_instance().datastore()
            uris = [datastore.get_label_uri(label, t) if label and t else "" for t in tags]
            if not uris or not all(u and u.endswith(".nrrd") for u in uris):
                return None
            if not merge:
                return saved_label_rle(uris[0])
            body, meta = merge_saved_labels(uris, tags.index(top_tag) if top_tag in tags else -1)
            meta["top"] = tags[meta["top"]] if meta.get("top", -1) >= 0 else ""
            return body, meta
        finally:
            current_user.reset(token)

    try:
        found = await anyio.to_thread.run_sync(work)
    except ValueError as e:  # e.g. saves of different images
        await _json(send, 400, {"detail": str(e)})
        return
    except Exception as e:
        logger.exception(f"user={user} GET {scope['path']} failed")
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
    logger.info(f"user={user} GET {scope['path']} tags={','.join(tags)} -> 200 ({len(body)} bytes)")


async def _airway_split(scope, receive, send, user):
    """POST /airways/split: the body is the viewer's airway mask, run-length
    encoded (lib/label_upload.py; optionally gzipped), and the X-Geometry
    header its {sizes, spacing, direction} as JSON. Answers with the trachea
    (1) / bronchi (2) labelmap in the same form and the X-Split-Meta header
    (voxel counts, trachea length, ...). See lib/airway_split.py."""
    import anyio

    geometry_raw = dict(scope.get("headers", [])).get(b"x-geometry", b"")
    chunks = []
    while True:
        message = await receive()
        chunks.append(message.get("body", b""))
        if not message.get("more_body"):
            break
    body = b"".join(chunks)
    start = time.monotonic()
    try:
        geometry = json.loads(geometry_raw.decode("latin-1") or "{}")

        def work():
            from lib.airway_split import split_airways

            return split_airways(body, geometry)

        out, meta = await anyio.to_thread.run_sync(work)
    except (ValueError, KeyError, TypeError) as e:  # bad input, or no carina found
        logger.info(f"user={user} POST /airways/split -> 422: {e}")
        await _json(send, 422, {"detail": str(e)})
        return
    except Exception as e:
        logger.exception(f"user={user} POST /airways/split failed")
        await _json(send, 500, {"detail": f"Airway split failed: {e}"})
        return
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [
                (b"content-type", b"application/octet-stream"),
                (b"content-length", str(len(out)).encode()),
                (b"cache-control", b"no-store"),
                (b"x-split-meta", json.dumps(meta).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": out})
    logger.info(f"user={user} POST /airways/split -> 200 in {time.monotonic() - start:.1f}s")


async def _fissure_analysis(scope, receive, send, user):
    """POST /fissures/analyse?image=<image id>: the body is the viewer's lobe
    mask, run-length encoded (1 = LUL, 2 = LLL, 3 = RUL, 4 = RML, 5 = RLL;
    optionally gzipped), and the X-Geometry header its {sizes, spacing,
    direction, origin} as JSON. The scan's CT comes from the user's datastore.
    Answers with the visible fissures (1 = left oblique, 2 = right oblique,
    3 = right horizontal) in the same form and the X-Fissure-Meta header with
    per-fissure results. See lib/fissure_analysis.py."""
    from urllib.parse import parse_qs

    import anyio

    image = (parse_qs(scope.get("query_string", b"").decode("latin-1")).get("image") or [""])[0]
    geometry_raw = dict(scope.get("headers", [])).get(b"x-geometry", b"")
    chunks = []
    while True:
        message = await receive()
        chunks.append(message.get("body", b""))
        if not message.get("more_body"):
            break
    body = b"".join(chunks)
    start = time.monotonic()
    try:
        geometry = json.loads(geometry_raw.decode("latin-1") or "{}")
        if not image:
            raise ValueError("no image given")

        def work():
            from monailabel.interfaces.utils.app import app_instance

            from lib.fissure_analysis import analyse_fissures

            token = current_user.set(user)  # this user's own datastore
            try:
                ct_path = app_instance().datastore().get_image_uri(image)
            finally:
                current_user.reset(token)
            if not ct_path:
                raise ValueError("this scan's CT is not available on the server - open it once with an AI model first")
            return analyse_fissures(body, geometry, ct_path)

        out, meta = await anyio.to_thread.run_sync(work)
    except (ValueError, KeyError, TypeError) as e:  # bad input, no lobes, ...
        logger.info(f"user={user} POST /fissures/analyse -> 422: {e}")
        await _json(send, 422, {"detail": str(e)})
        return
    except Exception as e:
        logger.exception(f"user={user} POST /fissures/analyse failed")
        await _json(send, 500, {"detail": f"Fissure analysis failed: {e}"})
        return
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [
                (b"content-type", b"application/octet-stream"),
                (b"content-length", str(len(out)).encode()),
                (b"cache-control", b"no-store"),
                (b"x-fissure-meta", json.dumps(meta).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": out})
    logger.info(f"user={user} POST /fissures/analyse -> 200 in {time.monotonic() - start:.1f}s")


async def _client_log(receive, send, user):
    """POST /client-log: the viewer reports its browser's capabilities and any
    errors (see docker/gateway/app-config.js), so problems on a user's own
    device show up in `./manage.sh user-logs <user>`. Size-capped."""
    body = b""
    while True:
        message = await receive()
        if len(body) < 20000:
            body += message.get("body", b"")
        if not message.get("more_body"):
            break
    text = body[:20000].decode("utf-8", "replace").replace("\n", " | ")
    logger.info(f"user={user} CLIENT {text}")
    await _json(send, 200, {})


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
        if scope["path"] == "/client-log" and scope["method"] == "POST":
            await _client_log(receive, send, user)
            return
        if scope["path"] == "/fissures/analyse" and scope["method"] == "POST":
            await _fissure_analysis(scope, receive, send, user)
            return
        if scope["path"] == "/airways/split" and scope["method"] == "POST":
            await _airway_split(scope, receive, send, user)
            return
        if scope["path"] in ("/datastore/label/rle", "/datastore/label/merge-rle") and scope["method"] == "GET":
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
