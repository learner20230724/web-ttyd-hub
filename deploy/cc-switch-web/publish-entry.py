#!/usr/bin/python3
"""Publish the mounted Web entry and keep the upstream credential server-side."""
import base64
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


APP_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else '/data-main/apps/cc-switch-web')
DATA_DIR = Path('/data-main/services/cc-switch-web')
PRIVATE_CONFIG = Path('/etc/cc-switch-web')
API_PREFIX = '/cc-switch/api'


def replace_text(path, content):
    pending = path.with_name(f'{path.name}.next')
    pending.write_text(content)
    pending.chmod(0o600)
    os.replace(pending, path)


def get_local(path, authorization):
    request = Request(f'http://127.0.0.1:17666{path}', headers={'Authorization': authorization})
    for attempt in range(20):
        try:
            with urlopen(request, timeout=2) as response:
                return response.read().decode()
        except URLError:
            if attempt == 19:
                raise
            time.sleep(0.25)


def main():
    os.umask(0o077)
    password = (DATA_DIR / '.cc-switch/web_password').read_text().strip()
    authorization = 'Basic ' + base64.b64encode(f'admin:{password}'.encode()).decode()
    template = APP_DIR / 'frontend/index.html'
    if template.is_file():
        html = template.read_text()
        token = json.loads(get_local(f'{API_PREFIX}/system/csrf-token', authorization))['csrfToken']
        if not isinstance(token, str) or not token:
            raise SystemExit('CC Switch Web did not return a CSRF token')
        csrf = json.dumps({'csrfToken': token}).replace('<', '\\u003c')
        settings = f'<script>window.__CC_SWITCH_API_BASE__ = "{API_PREFIX}"; window.__CC_SWITCH_TOKENS__ = {csrf};</script>'
        html = html.replace('</head>', settings + '</head>', 1)
    else:
        html = get_local('/', authorization)
        if f'"{API_PREFIX}"' not in html:
            raise SystemExit('CC Switch Web API prefix is missing')
        html = re.sub(r'((?:src|href)=["\'])/(?=[^/])', r'\1/cc-switch/', html)

    first_visit = """<script>try {
  if (!localStorage.getItem('cc-switch:active-app')) localStorage.setItem('cc-switch:active-app', 'codex');
} catch {}</script>"""
    html = html.replace('</head>', first_visit + '</head>', 1)
    sign_out = """<a href="/cc-switch/_access/logout" style="position:fixed;z-index:20;
right:12px;bottom:12px;display:grid;place-items:center;min-height:42px;padding:0 12px;
border:1px solid color-mix(in srgb, CanvasText 20%, Canvas);border-radius:8px;
background:Canvas;color:CanvasText;font:14px system-ui;text-decoration:none">退出登录</a>"""
    html = html.replace('</body>', sign_out + '</body>', 1)
    replace_text(PRIVATE_CONFIG / 'upstream.caddy', f'header_up Authorization "{authorization}"\n')
    replace_text(PRIVATE_CONFIG / 'upstream-auth', authorization + '\n')
    replace_text(APP_DIR / 'index.html', html)


if __name__ == '__main__':
    main()
