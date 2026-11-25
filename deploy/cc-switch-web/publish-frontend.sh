#!/usr/bin/env bash
set -euo pipefail

scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
app_dir=$(realpath "${CC_SWITCH_APP_DIR:-/data-main/apps/cc-switch-web}")
source_dir="$app_dir/cc-switch-web-0.21.0"
changes="$scripts/frontend-v0.21.0.patch"

exec 9>"$app_dir/.frontend-publish.lock"
flock 9

cd "$source_dir"
if patch --batch --forward --dry-run -s -p1 < "$changes"; then
  patch --batch --forward -p1 < "$changes"
else
  patch --batch --reverse --dry-run -s -p1 < "$changes"
fi
npm exec --yes --package=pnpm@10.10.0 -- pnpm install --frozen-lockfile
npm exec --yes --package=pnpm@10.10.0 -- pnpm run build:web --base /cc-switch/frontend/
install -d "$app_dir/frontend/assets"
cp -a --update=none dist-web/assets/. "$app_dir/frontend/assets/"
install -m 0644 dist-web/index.html "$app_dir/frontend/index.html.next"
mv -f "$app_dir/frontend/index.html.next" "$app_dir/frontend/index.html"
python3 "$scripts/publish-entry.py" "$app_dir"
