#!/usr/bin/env python3
"""Deploy the server and online Android UI without terminating tmux tasks (systemd)."""
import json, os, pathlib, subprocess, time, urllib.request
from datetime import datetime, timezone

root = pathlib.Path(__file__).resolve().parents[1]
service = os.environ.get('HUB_SERVICE', 'web-ttyd-hub.service')
base = os.environ.get('HUB_LOCAL_URL', 'http://127.0.0.1:3000')
def command(*args):
    return subprocess.check_output(args, text=True).strip()
def api(path='', data=None, method=None):
    request = urllib.request.Request(base + '/api/sessions' + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json'}, method=method)
    with urllib.request.urlopen(request, timeout=15) as response: return json.load(response)

if command('systemctl', 'show', service, '-p', 'KillMode', '--value') != 'process':
    raise SystemExit('Refusing restart: configure KillMode=process to preserve tmux tasks first.')
subprocess.run(['npm', 'run', 'build'], cwd=root, check=True)
sessions = api()['sessions']
panes = command('tmux', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}') if sessions else ''
backup = pathlib.Path(os.environ.get('HUB_BACKUP_DIR', '/root/hub-deploy-backups')) / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup.mkdir(parents=True, mode=0o700)
os.chmod(backup, 0o700)
(backup / 'sessions.json').write_text(json.dumps(sessions, ensure_ascii=False, indent=2))
(backup / 'panes.txt').write_text(panes)
subprocess.run(['systemctl', 'restart', service], check=True)
for attempt in range(100):
    try: api(); break
    except Exception: time.sleep(.1)
else: raise SystemExit(f'Server failed to start; recovery snapshot: {backup}')
# New servers restore themselves. Only migrate entries absent from durable state.
restored = {s['name'] for s in api()['sessions']}
missing = [s for s in sessions if s['name'] not in restored]
for session in missing:
    api(data={'name':session['name'], 'shell':session.get('shell')}, method='POST')
for session in missing:
    name = session['name']
    if session.get('displayName', name) != name: api('/' + name, {'name':session['displayName']}, 'PATCH')
    if session['status'] != 'running': api('/' + name + '/stop', {}, 'POST')
after = command('tmux', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}') if sessions else ''
if not set(panes.splitlines()).issubset(after.splitlines()):
    raise SystemExit(f'Pane IDs/PIDs changed: inspect recovery snapshot {backup}')
print(f'Deployed web + Android online UI; restored {len(sessions)} sessions, tmux PIDs preserved. Backup: {backup}')
