"""Login service for the ILD-SemiSegTool deployment.

- GET/POST /login, GET /logout: the login page and session cookie.
- GET /auth/check: called by the gateway (Caddy forward_auth) before every
  request; answers 200 + X-User for a valid session, otherwise sends the
  browser to /login (or 401 for background requests).
- CLI (run via ../manage.sh): add-user, passwd, remove-user, list.

Users live in /data/users.json as scrypt hashes; the cookie is signed with
/data/secret.key and includes a fingerprint of the user's password hash, so
changing a password (or removing the user) logs out every device at once.
"""

import base64
import getpass
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote

DATA = Path(os.environ.get("LOGIN_DATA_DIR", "/data"))
USERS_FILE = DATA / "users.json"
SECRET_FILE = DATA / "secret.key"
SESSION_HOURS = float(os.environ.get("SESSION_HOURS", "12"))
COOKIE = "ild_session"
# Same rule as backend/lib/user_context.py: usernames become container
# names (orthanc-<user>) and folder names.
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

_lock = threading.Lock()


# --- users -----------------------------------------------------------------


_users_cache = (None, {})  # (file mtime, users) - /auth/check runs on every image request


def load_users():
    global _users_cache
    try:
        mtime = USERS_FILE.stat().st_mtime_ns
    except FileNotFoundError:
        return {}
    if _users_cache[0] != mtime:
        _users_cache = (mtime, json.loads(USERS_FILE.read_text()))
    return _users_cache[1]


def save_users(users):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = USERS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(users, indent=2, sort_keys=True))
    tmp.replace(USERS_FILE)


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def check_password(password, stored):
    try:
        _, salt, digest = stored.split("$")
        actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=2**14, r=8, p=1)
        return hmac.compare_digest(actual, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


# --- sessions --------------------------------------------------------------


def secret_key():
    if not SECRET_FILE.exists():
        DATA.mkdir(parents=True, exist_ok=True)
        SECRET_FILE.write_bytes(secrets.token_bytes(32))
        SECRET_FILE.chmod(0o600)
    return SECRET_FILE.read_bytes()


def _sign(user, expires, password_hash):
    msg = f"{user}|{expires}|{password_hash}".encode()
    return hmac.new(secret_key(), msg, hashlib.sha256).hexdigest()


def make_session(user, password_hash):
    expires = int(time.time() + SESSION_HOURS * 3600)
    return f"{user}|{expires}|{_sign(user, expires, password_hash)}"


def session_user(token):
    """Username for a valid, unexpired session token, else None."""
    try:
        user, expires, sig = (token or "").split("|")
        expires = int(expires)
    except ValueError:
        return None
    entry = load_users().get(user)
    if not entry or expires < time.time():
        return None
    return user if hmac.compare_digest(sig, _sign(user, expires, entry["password"])) else None


# --- web app ---------------------------------------------------------------


def create_app():
    from fastapi import FastAPI, Form, Request
    from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    page = (Path(__file__).parent / "login.html").read_text()
    failures = {}  # username -> (count, last_failure_time), slows down password guessing

    def safe_next(target):
        # Only same-site paths - never redirect a user off to another site.
        return target if target and target.startswith("/") and not target.startswith("//") else "/"

    def login_page(next_url, error="", status=200):
        body = page.replace("{{next}}", html.escape(next_url, quote=True)).replace(
            "{{error}}", f'<p class="error">{html.escape(error)}</p>' if error else ""
        )
        return HTMLResponse(body, status_code=status, headers={"Cache-Control": "no-store"})

    @app.get("/auth/check")
    def auth_check(request: Request):
        user = session_user(request.cookies.get(COOKIE))
        if user:
            admin = "1" if load_users().get(user, {}).get("admin") else "0"
            return Response(status_code=200, headers={"X-User": user, "X-User-Admin": admin})
        # Page loads get sent to the login form; background requests
        # (images, API calls) just get 401.
        if request.headers.get("x-forwarded-method", "GET") == "GET" and "text/html" in request.headers.get(
            "accept", ""
        ):
            back = request.headers.get("x-forwarded-uri", "/")
            return RedirectResponse(f"/login?next={quote(safe_next(back))}", status_code=302)
        return JSONResponse({"detail": "Not logged in"}, status_code=401)

    @app.get("/login")
    def login_form(next: str = "/"):
        return login_page(safe_next(next))

    @app.post("/login")
    def login(request: Request, username: str = Form(""), password: str = Form(""), next: str = Form("/")):
        username = username.strip().lower()
        count, last = failures.get(username, (0, 0))
        if count >= 5 and time.time() - last < 60:
            return login_page(safe_next(next), "Too many attempts - wait a minute and try again.", 429)

        entry = load_users().get(username)
        client = request.headers.get("x-forwarded-for", request.client.host if request.client else "?")
        if not entry or not check_password(password, entry["password"]):
            failures[username] = (count + 1, time.time())
            print(f"login failed user={username} from={client}" + ("" if entry else " (no such user)"), flush=True)
            return login_page(safe_next(next), "Wrong username or password.", 401)

        failures.pop(username, None)
        print(f"login ok user={username} from={client}", flush=True)
        response = RedirectResponse(safe_next(next), status_code=303)
        response.set_cookie(
            COOKIE,
            make_session(username, entry["password"]),
            max_age=int(SESSION_HOURS * 3600),
            httponly=True,
            samesite="lax",
            secure=request.headers.get("x-forwarded-proto") == "https",
            path="/",
        )
        return response

    @app.get("/logout")
    def logout():
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie(COOKIE, path="/")
        return response

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "users": len(load_users())}

    return app


# --- CLI -------------------------------------------------------------------


def _ask_password():
    password = os.environ.get("NEW_PASSWORD") or getpass.getpass("Password: ")
    if not os.environ.get("NEW_PASSWORD") and password != getpass.getpass("Repeat password: "):
        sys.exit("Passwords don't match.")
    if len(password) < 8:
        sys.exit("Password must be at least 8 characters.")
    return password


def cli(argv):
    usage = "usage: app.py add-user NAME [--admin] | passwd NAME | remove-user NAME | list"
    if not argv:
        sys.exit(usage)
    cmd, args = argv[0], argv[1:]
    with _lock:
        users = load_users()
        if cmd == "list":
            for name in sorted(users):
                print(name + ("  (admin)" if users[name].get("admin") else ""))
            return
        if not args:
            sys.exit(usage)
        name = args[0].strip().lower()
        if cmd == "add-user":
            if not USERNAME_RE.match(name):
                sys.exit("Username: 1-32 characters, lowercase letters, digits, '-' or '_', starting with a letter/digit.")
            if name in users:
                sys.exit(f"User '{name}' already exists (use passwd to change the password).")
            users[name] = {"password": hash_password(_ask_password()), "admin": "--admin" in args}
            save_users(users)
            print(f"Added user '{name}'.")
        elif cmd == "passwd":
            if name not in users:
                sys.exit(f"No user '{name}'.")
            users[name]["password"] = hash_password(_ask_password())
            save_users(users)
            print(f"Password changed for '{name}' (their other sessions are logged out).")
        elif cmd == "remove-user":
            if users.pop(name, None) is None:
                sys.exit(f"No user '{name}'.")
            save_users(users)
            print(f"Removed user '{name}'.")
        else:
            sys.exit(usage)


if __name__ == "__main__":
    cli(sys.argv[1:])
else:
    app = create_app()
