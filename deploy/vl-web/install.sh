#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
data=/data-main/services/vl-web
root="$data/root"
mountpoint -q /data-main
vl_bin=$(command -v vl)
rg_bin=$(command -v rg)
getent passwd vl-web >/dev/null || useradd --system --no-create-home --home-dir /preferences --shell /usr/sbin/nologin vl-web
install -d -m 755 "$root"/{bin,workspace,preferences,run,dev,proc,tmp}
install -d -m 700 -o vl-web -g vl-web "$data/workspace" "$data/preferences"

# Give the editor only its own filesystem and the binaries used for local search and diffs.
uv_plugin=$(dpkg-query -L libwebsockets-evlib-uv | grep '/libwebsockets-evlib_uv.so$')
for executable in "$vl_bin" /usr/bin/ttyd /usr/bin/git "$rg_bin" "$uv_plugin"; do
  target=/bin/$(basename "$executable")
  if [[ "$executable" == "$uv_plugin" ]]; then target=$uv_plugin; fi
  install -D -m 755 "$executable" "$root$target"
  if readelf -d "$executable" | grep '(NEEDED)' >/dev/null; then
    dependencies=$(ldd "$executable")
    while read -r library; do
      install -D -m 755 "$library" "$root$library"
    done < <(awk '{ for (i=1; i<=NF; i++) if ($i ~ /^\//) print $i }' <<<"$dependencies")
  fi
done
if [[ ! -e "$data/workspace/工作区.md" && ! -e "$data/.seeded" ]]; then
  install -m 600 -o vl-web -g vl-web "$source_dir/工作区.md" "$data/workspace/工作区.md"
fi
touch "$data/.seeded"
python3 "$source_dir/build-client.py" "$root/client.next.html"
chmod 644 "$root/client.next.html"
mv -fT "$root/client.next.html" "$root/client.html"
install -m 644 "$source_dir/vl-web.service" /etc/systemd/system/vl-web.service
systemctl daemon-reload
systemctl enable vl-web.service
systemctl restart vl-web.service
