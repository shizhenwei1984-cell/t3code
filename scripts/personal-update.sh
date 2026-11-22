#!/usr/bin/env bash
# Linux x86_64 desktop updater for the personal fork.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
[[ $(uname -sm) == 'Linux x86_64' ]]
state="$HOME/.local/state/t3code-personal-updates"
opt="$HOME/.local/opt"
current="$opt/t3code-personal-current"
mkdir -p -m 700 "$state"
exec 9>"$state/update.lock"
flock -n 9 || { echo "Another personal desktop update is running." >&2; exit 1; }
[[ -x "$current/t3code" ]] || { echo "Set up the personal launcher and current release link first." >&2; exit 1; }
export PYTHONDONTWRITEBYTECODE=1
python3 scripts/personal-install.py --recover
if [[ "$*" == --rollback ]]; then exec python3 scripts/personal-install.py --rollback; fi
[[ "$*" == --install || "$*" == '--install --push' ]] || { echo 'Usage: --install [--push] | --rollback' >&2; exit 2; }
[[ -z $(git status --porcelain) && $(git branch --show-current) == feature/cursor-on-demand ]] || {
  echo "Start on a clean feature/cursor-on-demand branch." >&2; exit 1;
}
upstream=pingdotgg/t3code
tag=$(gh release view --repo "$upstream" --json tagName --jq .tagName)
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
before=$(git rev-parse HEAD)
work=$(mktemp -d "$opt/.personal-build-XXXXXXXX")
merged=
cleanup() {
  rc=$?
  if (( rc )) && [[ -n $merged && $(git rev-parse HEAD) == "$merged" && -z $(git status --porcelain) ]]; then
    git reset --keep "$before" || echo "Restore the source checkout to $before when ready." >&2
  fi
  rm -rf -- "$work"
  exit "$rc"
}
trap cleanup EXIT
if ! T3_PERSONAL_STABLE_TAG="$tag" ./scripts/sync-upstream.sh; then
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git merge --abort; fi
  if [[ -z $(git status --porcelain) ]]; then git reset --keep "$before"; fi
  exit 1
fi
merged=$(git rev-parse HEAD)
export APP_VERSION="${tag#v}-personal.g${merged:0:10}"
if command -v pnpm >/dev/null; then pnpm install --frozen-lockfile
else
  corepack=$(command -v corepack || realpath "$(dirname "$(readlink -f "$(command -v node)")")/corepack")
  "$corepack" pnpm install --frozen-lockfile
fi
export PATH="$repo/node_modules/.bin:$PATH"
bash scripts/tests/sync-upstream.sh
python3 scripts/tests/personal-install.py
apps/web/node_modules/.bin/playwright install chromium --only-shell
vp run check:changed "$tag"
(cd packages/provider-cursor && vp test run src/server/usageLimits.test.ts)
(cd apps/web && vp build)
(cd apps/server && vp pack)
asset="T3-Code-${tag#v}-amd64.deb"
digest=$(gh release view "$tag" --repo "$upstream" --json assets --jq ".assets[] | select(.name == \"$asset\") | .digest")
[[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Missing upstream Debian asset digest." >&2; exit 1; }
cache="${XDG_CACHE_HOME:-$HOME/.cache}/t3code-personal"
mkdir -p "$cache"
verify() { printf '%s  %s\n' "${digest#sha256:}" "$1" | sha256sum --check --status; }
if [[ ! -f "$cache/$asset" ]] || ! verify "$cache/$asset"; then
  gh release download "$tag" --repo "$upstream" --pattern "$asset" --dir "$work"
  verify "$work/$asset"
  cp "$work/$asset" "$cache/$asset.tmp"
  mv "$cache/$asset.tmp" "$cache/$asset"
fi
dpkg-deb -x "$cache/$asset" "$work/deb"
app="$work/deb/opt/T3 Code (Beta)"
resources="$app/resources"
asar="$repo/scripts/node_modules/.bin/asar"
"$asar" extract "$resources/app.asar" "$work/bundle"
dist="$work/bundle/apps/server/dist"
[[ -f "$dist/bin.mjs" && -f "$dist/client/index.html" && -f apps/web/dist/index.html ]]
find "$dist" -maxdepth 1 -name '*.mjs' -delete
cp apps/server/dist/*.mjs "$dist/"
rm -rf "$dist/client"
cp -a apps/web/dist "$dist/client"
node --input-type=commonjs - "$work/bundle/package.json" "$APP_VERSION" "$merged" <<'JS'
const fs = require("node:fs");
const [file, version, commit] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file));
Object.assign(pkg, {version, buildVersion:version, t3codeCommitHash:commit});
fs.writeFileSync(file, JSON.stringify(pkg));
JS
rm -rf "$resources/app.asar.unpacked" "$resources/server-compile-cache"
"$asar" pack "$work/bundle" "$resources/app.asar" --unpack-dir node_modules
sandbox=$(readlink -f "$current/chrome-sandbox")
[[ -u "$sandbox" && $(stat -c %u "$sandbox") == 0 ]] || { echo 'Missing installed root-owned SUID Chrome sandbox helper.' >&2; exit 1; }
ln -sfn "$sandbox" "$app/chrome-sandbox"
candidate=$(mktemp -d "$opt/t3code-$APP_VERSION-XXXXXXXX")
mv -T "$app" "$candidate"
python3 scripts/personal-install.py "$candidate"
# The installed release is healthy. An optional remote publication can be retried separately.
merged=
if [[ ${2:-} == --push ]]; then git push origin HEAD:refs/heads/feature/cursor-on-demand; fi
