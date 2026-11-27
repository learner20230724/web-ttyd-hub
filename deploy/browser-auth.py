#!/usr/bin/env python3
"""Persistent browser sign-in for the terminal and its companion tools."""

import base64
import hashlib
import hmac
import html
import json
import re
import secrets
import sqlite3
import sys
import time
from contextlib import closing
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore
from urllib.parse import parse_qs, quote, unquote, urlsplit

import bcrypt
from cryptography.fernet import Fernet, InvalidToken

DAYS = 30 * 86400
BROWSER_SESSION = 12 * 3600
LOGIN_WINDOW = 600
MAX_ATTEMPTS = 8
FORM_LIMIT = 4096
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
SAFE_LOCATION = re.compile(r"^/[^\\\x00-\x20\x7f]*$")


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def matches_route(path, route):
    return path == route or path.startswith(route.rstrip("/") + "/")


def return_path(value, profile):
    if value.isascii() and SAFE_LOCATION.fullmatch(value) and not value.startswith("//"):
        path = unquote(urlsplit(value).path)
        if SAFE_LOCATION.fullmatch(path) and not path.startswith("//") and not {".", ".."}.intersection(path.split("/")):
            if any(matches_route(path, root) for root in profile["routes"]) and not matches_route(path, profile["entry"]):
                return value
    return profile["home"]


class SessionStore:
    def __init__(self, database):
        self.database = database
        with closing(self.open()) as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, scope TEXT NOT NULL, expires INTEGER NOT NULL, relay TEXT
                );
                CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
                CREATE TABLE IF NOT EXISTS attempts (
                    scope TEXT NOT NULL, client TEXT NOT NULL, window INTEGER NOT NULL,
                    count INTEGER NOT NULL, PRIMARY KEY(scope, client, window)
                );
            """)

    def open(self):
        return sqlite3.connect(self.database, timeout=5)

    def attempt(self, scope, client, now):
        window = now // LOGIN_WINDOW
        with closing(self.open()) as db, db:
            db.execute("DELETE FROM attempts WHERE window<?", (window,))
            count = db.execute("""
                INSERT INTO attempts VALUES (?, ?, ?, 1)
                ON CONFLICT(scope, client, window) DO UPDATE SET count=count+1
                RETURNING count
            """, (scope, client, window)).fetchone()[0]
            return count <= MAX_ATTEMPTS

    def issue(self, scope, client, previous, session_id, now, lifetime, relay):
        with closing(self.open()) as db, db:
            db.execute("DELETE FROM sessions WHERE expires<=? OR (id=? AND scope=?)", (now, previous, scope))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (session_id, scope, now + lifetime, relay))
            db.execute("DELETE FROM attempts WHERE scope=? AND client=?", (scope, client))

    def find(self, scope, session_id, now):
        with closing(self.open()) as db:
            return db.execute("SELECT relay FROM sessions WHERE id=? AND scope=? AND expires>?",
                              (session_id, scope, now)).fetchone()

    def revoke(self, scope, session_id):
        with closing(self.open()) as db, db:
            db.execute("DELETE FROM sessions WHERE id=? AND scope=?", (session_id, scope))


class BrowserAuth(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, profiles, database, relay_key, clock=time.time):
        super().__init__(address, Handler)
        self.profiles = profiles
        self.store = SessionStore(database)
        self.relay = Fernet(relay_key)
        self.clock = clock
        self.verifiers = BoundedSemaphore(4)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, body="", headers=()):
        data = body.encode()
        self.send_response(status)
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data and self.command != "HEAD":
            self.wfile.write(data)

    def session_id(self, token):
        return digest(self.scope + ":" + self.profile["password_hash"] + ":" + token)

    def current_session(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", "")).get(self.profile["cookie"])
        except CookieError:
            return None
        if cookie and TOKEN.fullmatch(cookie.value):
            return self.session_id(cookie.value)
        return None

    def cookie_headers(self, token, age):
        suffix = "; HttpOnly; Secure; SameSite=Lax"
        if age is not None:
            suffix += f"; Max-Age={age}"
        return [("Set-Cookie", f"{self.profile['cookie']}={token}; Path={path}{suffix}")
                for path in self.profile["cookie_paths"]]

    def page(self, status=200, next_path="", message="", logout=False):
        name = html.escape(self.profile["name"])
        entry = html.escape(self.profile["entry"])
        target = html.escape(next_path, quote=True)
        action = "logout" if logout else "login"
        label = "退出登录" if logout else "登录"
        fields = "" if logout else """
          <label>账号<input name="username" required maxlength="100" autocomplete="username"></label>
          <label>密码<input name="password" type="password" required maxlength="72" autocomplete="current-password"></label>
          <label class="remember"><input name="remember" type="checkbox" value="1"> 记住此设备 30 天</label>"""
        notice = f'<p role="alert">{html.escape(message)}</p>' if message else ""
        self.respond(status, f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{name} · {label}</title>
<style>
:root{{color:#172423;background:#f1f5f3;font:16px system-ui,sans-serif}}
body{{min-height:100dvh;display:grid;place-items:center;margin:0;padding:1rem;box-sizing:border-box}}
main{{background:#fff;border:1px solid #d7e3de;padding:clamp(1.3rem,5vw,2.2rem);width:min(100%,25rem);border-radius:1rem;box-sizing:border-box}}
h1{{margin:0 0 1.4rem;font-size:1.55rem}}label{{display:block;margin:1rem 0}}
input:not([type=checkbox]){{display:block;width:100%;box-sizing:border-box;margin-top:.4rem;padding:.75rem;border:1px solid #879b92;border-radius:.45rem;font:inherit}}
.remember{{display:flex;align-items:center;gap:.4rem}}input[type=checkbox]{{width:1.1rem;height:1.1rem;accent-color:#184b3f}}
button{{width:100%;background:#184b3f;color:white;border:0;border-radius:.45rem;padding:.8rem;font:inherit;cursor:pointer}}
[role=alert]{{color:#9c2525}}a{{color:#184b3f;display:inline-block;margin-top:1rem}}
</style><main><h1>{name}</h1>{notice}<form method="post" action="{entry}/{action}">
<input type="hidden" name="return" value="{target}">{fields}<button>{label}</button></form>
{f'<a href="{target}">返回</a>' if logout else ''}</main></html>""")

    def verify(self):
        current = self.current_session()
        row = self.server.store.find(self.scope, current, self.now) if current else None
        if row:
            headers = []
            if row[0]:
                try:
                    upstream = self.server.relay.decrypt(row[0].encode()).decode()
                except InvalidToken:
                    self.server.store.revoke(self.scope, current)
                    self.respond(401)
                    return
                headers.append(("X-Browser-Upstream", upstream))
            self.respond(204, headers=headers)
            return
        method = self.headers.get("X-Forwarded-Method")
        if method == "GET" and (self.headers.get("Sec-Fetch-Mode") == "navigate" or
                                "text/html" in self.headers.get("Accept", "")):
            next_path = return_path(self.headers.get("X-Forwarded-Uri", ""), self.profile)
            self.respond(303, headers=[("Location", self.profile["entry"] + "/login?return=" + quote(next_path, safe=""))])
        else:
            self.respond(401)

    def read_form(self):
        length = self.headers.get("Content-Length", "")
        if not length.isdecimal() or not 0 < int(length) <= FORM_LIMIT:
            return None
        if self.headers.get_content_type() != "application/x-www-form-urlencoded":
            return None
        try:
            fields = parse_qs(self.rfile.read(int(length)).decode(), max_num_fields=8)
        except (UnicodeError, ValueError):
            return None
        return {key: values[0] for key, values in fields.items()}

    def login(self, form, next_path):
        client = self.headers.get("X-Login-Client", "")[:64]
        username = form.get("username", "")
        password = form.get("password", "").encode()
        if not 0 < len(password) <= 72 or not username or len(username) > 100:
            self.page(400, next_path, "请输入账号和密码。")
            return
        if not self.server.store.attempt(self.scope, client, self.now):
            self.page(429, next_path, "尝试次数过多，请稍后再试。")
            return
        if not self.server.verifiers.acquire(blocking=False):
            self.page(503, next_path, "登录服务正忙，请稍后再试。")
            return
        try:
            password_ok = bcrypt.checkpw(password, self.profile["password_hash"].encode())
            username_ok = hmac.compare_digest(username.encode(), self.profile["username"].encode())
        finally:
            self.server.verifiers.release()
        if not (username_ok and password_ok):
            self.page(401, next_path, "账号或密码不正确。")
            return
        relay = None
        if self.profile.get("relay_basic"):
            upstream = "Basic " + base64.b64encode(username.encode() + b":" + password).decode()
            relay = self.server.relay.encrypt(upstream.encode()).decode()
        remembered = form.get("remember") == "1"
        token = secrets.token_urlsafe(32)
        self.server.store.issue(self.scope, client, self.current_session(), self.session_id(token),
                                self.now, DAYS if remembered else BROWSER_SESSION, relay)
        self.respond(303, headers=[("Location", next_path), *self.cookie_headers(token, DAYS if remembered else None)])

    def handle_request(self):
        self.scope = self.headers.get("X-Login-Scope")
        self.profile = self.server.profiles.get(self.scope)
        self.now = int(self.server.clock())
        route = urlsplit(self.path)
        if not self.profile:
            self.respond(404)
        elif self.command == "GET" and route.path == "/verify":
            self.verify()
        elif route.path not in ("/login", "/logout"):
            self.respond(404)
        elif self.command == "GET":
            try:
                arguments = parse_qs(route.query, max_num_fields=8)
            except ValueError:
                self.respond(400)
                return
            self.page(next_path=return_path(arguments.get("return", [""])[0], self.profile),
                      logout=route.path == "/logout")
        elif self.command == "POST":
            if self.headers.get("Origin") not in self.profile["origins"]:
                self.respond(403)
                return
            form = self.read_form()
            if form is None:
                self.respond(400)
                return
            next_path = return_path(form.get("return", ""), self.profile)
            if route.path == "/login":
                self.login(form, next_path)
            else:
                self.server.store.revoke(self.scope, self.current_session())
                self.respond(303, headers=[("Location", self.profile["entry"] + "/login?return=" + quote(next_path, safe="")),
                                           *self.cookie_headers("", 0)])
        else:
            self.respond(405)

    do_GET = handle_request
    do_POST = handle_request


if __name__ == "__main__":
    config = json.loads(Path(sys.argv[1]).read_text())
    key = Path(sys.argv[3]).read_bytes().strip()
    with BrowserAuth(("127.0.0.1", int(sys.argv[4])), config, sys.argv[2], key) as server:
        server.serve_forever()
