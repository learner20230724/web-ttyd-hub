#!/usr/bin/env python3
"""Publish signed APK to the existing IP download route. Never copies build secrets."""
import argparse, hashlib, os, pathlib, re, shutil, subprocess
parser = argparse.ArgumentParser()
parser.add_argument('apk', type=pathlib.Path)
parser.add_argument('version')
parser.add_argument('--directory', type=pathlib.Path, default=pathlib.Path('/srv/ttyd-hub/apk'))
args = parser.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+', args.version): parser.error('version must be x.y.z')
signer = os.environ.get('APKSIGNER') or shutil.which('apksigner') or '/opt/android-sdk/build-tools/36.0.0/apksigner'
subprocess.run([signer, 'verify', str(args.apk)], check=True)
args.directory.mkdir(parents=True, exist_ok=True)
blob = args.apk.read_bytes()
digest = hashlib.sha256(blob).hexdigest()
for filename in [f'ttyd-hub-android-{args.version}.apk', 'ttyd-hub-latest.apk']:
    dest = args.directory / filename
    temp = dest.with_suffix('.tmp')
    temp.write_bytes(blob); temp.chmod(0o644); os.replace(temp, dest)
    checksum = args.directory / (filename + '.sha256')
    temp = checksum.with_suffix('.tmp')
    temp.write_text(digest + '  ' + filename + '\n'); temp.chmod(0o644); os.replace(temp, checksum)
print('http://42.192.115.30:8182/downloads/ttyd-hub/ttyd-hub-latest.apk')
print('SHA-256:', digest)
