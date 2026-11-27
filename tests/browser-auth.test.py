import base64
import hashlib
import importlib.util
import json
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import bcrypt
from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("browser_auth", ROOT / "deploy/browser-auth.py")
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)
USERNAME = "sample"
PASSWORD = "test-only-password"
UPSTREAM = "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            key = self.headers["Sec-WebSocket-Key"]
            accepted = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Connection", "Upgrade")
            self.send_header("Upgrade", "websocket")
            self.send_header("Sec-WebSocket-Accept", accepted)
            self.end_headers()
            return
        data = json.dumps({
            "authorized": self.headers.get("Authorization") == UPSTREAM,
            "relayHeader": self.headers.get("X-Browser-Upstream") is not None,
            "path": self.path,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class BrowserAuthTest(unittest.TestCase):
    def test_proxy_login_restart_expire_and_logout(self):
        with tempfile.TemporaryDirectory() as scratch:
            temp = Path(scratch)
            now = 1000000
            bcrypt_hash = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode()
            profiles = {}
            for scope in ("home", "cc"):
                entry = f"/{scope}/_access"
                profiles[scope] = {
                    "entry": entry, "home": f"/{scope}/", "name": scope,
                    "origins": ["https://example.test"],
                    "routes": [f"/{scope}", "/download" if scope == "home" else f"/{scope}"],
                    "cookie": f"login-{scope}", "cookie_paths": [f"/{scope}"],
                    "username": USERNAME, "password_hash": bcrypt_hash,
                    "relay_basic": scope == "home",
                }
            gateway = auth.BrowserAuth(("127.0.0.1", 0), profiles, temp / "sessions.db", Fernet.generate_key(), lambda: now)
            self.addCleanup(gateway.server_close)
            threading.Thread(target=gateway.serve_forever, daemon=True).start()
            self.addCleanup(gateway.shutdown)
            fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
            self.addCleanup(fixture.server_close)
            threading.Thread(target=fixture.serve_forever, daemon=True).start()
            self.addCleanup(fixture.shutdown)
            with ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as unused:
                proxy_port = unused.server_port
            snippets = (ROOT / "deploy/browser-auth.caddy").read_text().replace(":4281", f":{gateway.server_port}")
            fixture_proxy = f"""
                reverse_proxy 127.0.0.1:{fixture.server_port} {{
                    header_up Authorization {{http.request.header.X-Browser-Upstream}}
                    header_up -X-Browser-Upstream
                    header_up -Cookie
                }}
            """
            caddyfile = temp / "Caddyfile"
            caddyfile.write_text(f"""
                {{
                    admin off
                    auto_https off
                }}
                {snippets}
                http://127.0.0.1:{proxy_port} {{
                    import browser_login home /home/_access
                    import browser_login cc /cc/_access
                    handle /home/* {{
                        route {{
                            import browser_authorize home
                            uri strip_prefix /home
                            {fixture_proxy}
                        }}
                    }}
                    handle /cc/* {{
                        route {{
                            import browser_authorize cc
                            {fixture_proxy}
                        }}
                    }}
                }}
            """)
            with (temp / "caddy.log").open("w+") as log:
                with subprocess.Popen(["caddy", "run", "--config", caddyfile], stdout=log, stderr=log) as proxy:
                    try:
                        self.run_checks(proxy_port, gateway, temp)
                        remembered = self.request(proxy_port, "POST", "/home/_access/login",
                                                  form={"username": USERNAME, "password": PASSWORD, "remember": "1"})
                        cookie = self.one_cookie(remembered)
                        now += auth.DAYS - 1
                        self.assertEqual(self.request(proxy_port, "GET", "/home/api", cookie=cookie)[0], 200)
                        now += 1
                        self.assertEqual(self.request(proxy_port, "GET", "/home/api", cookie=cookie)[0], 401)
                    finally:
                        proxy.terminate()

    def request(self, port, method, path, form=None, cookie=None, **extra):
        headers = {"Accept": "application/json", **extra}
        if form is not None:
            headers.setdefault("Origin", "https://example.test")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if cookie:
            headers["Cookie"] = cookie
        client = HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            client.request(method, path, body=urlencode(form) if form is not None else None, headers=headers)
            with client.getresponse() as response:
                return response.status, dict(response.getheaders()), b"" if response.status == 101 else response.read()
        finally:
            client.close()

    def one_cookie(self, response):
        self.assertEqual(response[0], 303)
        return response[1]["Set-Cookie"].split(";", 1)[0]

    def run_checks(self, port, gateway, temp):
        for _ in range(40):
            try:
                self.assertEqual(self.request(port, "GET", "/home/api")[0], 401)
                break
            except ConnectionRefusedError:
                time.sleep(.05)
        else:
            self.fail("Caddy did not bind")
        status, headers, _ = self.request(port, "GET", "/home/term?session=example", Accept="text/html")
        self.assertEqual(status, 303)
        self.assertTrue(headers["Location"].startswith("/home/_access/login?return="))
        status, _, html = self.request(port, "GET", headers["Location"])
        self.assertEqual(status, 200)
        self.assertIn("记住此设备 30 天".encode(), html)

        form = {"username": USERNAME, "password": PASSWORD, "remember": "1", "return": "/home/term?session=example"}
        self.assertEqual(self.request(port, "POST", "/home/_access/login", form=form, Origin="https://other.test")[0], 403)
        self.assertEqual(self.request(port, "POST", "/home/_access/login", form={**form, "password": "incorrect"})[0], 401)
        result = self.request(port, "POST", "/home/_access/login", form=form)
        cookie = self.one_cookie(result)
        self.assertEqual(result[1]["Location"], form["return"])
        self.assertIn("Max-Age=2592000", result[1]["Set-Cookie"])
        for attribute in ("Secure", "HttpOnly", "SameSite=Lax"):
            self.assertIn(attribute, result[1]["Set-Cookie"])
        token = cookie.split("=", 1)[1]
        with sqlite3.connect(temp / "sessions.db") as db:
            session_id, enc = db.execute("SELECT id,relay FROM sessions").fetchone()
            self.assertNotIn(token, session_id)
            for value in (PASSWORD, UPSTREAM):
                self.assertNotIn(value, enc)
        gateway.store = auth.SessionStore(temp / "sessions.db")
        status, _, body = self.request(port, "GET", "/home/term?session=example", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"authorized": True, "relayHeader": False, "path": "/term?session=example"})
        self.assertEqual(self.request(port, "GET", "/cc/api", cookie=cookie)[0], 401)
        websocket = {"Connection": "Upgrade", "Upgrade": "websocket",
                     "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}
        self.assertEqual(self.request(port, "GET", "/home/ws", **websocket)[0], 401)
        self.assertEqual(self.request(port, "GET", "/home/ws", cookie=cookie, **websocket)[0], 101)
        self.assertEqual(self.request(port, "GET", "/home/api", **{"X-Browser-Upstream": UPSTREAM})[0], 401)
        logged_out = self.request(port, "POST", "/home/_access/logout", form={"return": "/home/"}, cookie=cookie)
        self.assertEqual(logged_out[0], 303)
        self.assertIn("Max-Age=0", logged_out[1]["Set-Cookie"])
        self.assertEqual(self.request(port, "GET", "/home/api", cookie=cookie)[0], 401)
        self.assertEqual(self.request(port, "GET", "/home/ws", cookie=cookie, **websocket)[0], 401)

        result = self.request(port, "POST", "/cc/_access/login",
                              form={**form, "remember": "0", "return": "//outside.test"})
        cookie = self.one_cookie(result)
        self.assertEqual(result[1]["Location"], "/cc/")
        self.assertNotIn("Max-Age", result[1]["Set-Cookie"])
        self.assertFalse(json.loads(self.request(port, "GET", "/cc/", cookie=cookie)[2])["authorized"])


if __name__ == "__main__":
    unittest.main()
