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


async def _reject(send):
    body = json.dumps({"detail": "Not logged in"}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 401,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


def wrap(inner):
    async def app(scope, receive, send):
        if scope["type"] != "http":  # lifespan/websocket: pass through untouched
            await inner(scope, receive, send)
            return
        user = _user_from_scope(scope)
        if user is None:
            await _reject(send)
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
