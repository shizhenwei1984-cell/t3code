#!/usr/bin/env bash
set -euo pipefail
tool=$(cd "$(dirname "$0")/.." && pwd)/sync-upstream.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
git init -q -b main "$tmp/up"
cd "$tmp/up"
git commit -qm base --allow-empty
git clone -q --bare . "$tmp/fork"
git clone -q "$tmp/fork" "$tmp/work"
git tag v1.0.0
git commit -qm stable --allow-empty
git tag v1.1.0
git commit -qm preview --allow-empty
git tag v1.2.0-rc.1
cd "$tmp/work"
git switch -qc feature/cursor-on-demand
git remote add upstream "$tmp/up"
git commit -qm personal --allow-empty
personal=$(git rev-parse HEAD)
git fetch -q upstream main
"$tool" --push
git merge-base --is-ancestor "$personal" HEAD
git merge-base --is-ancestor v1.1.0 HEAD
if git merge-base --is-ancestor "$(git -C "$tmp/up" rev-parse v1.2.0-rc.1)" HEAD; then exit 1; fi
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/feature/cursor-on-demand)"
touch pending
if "$tool" --main; then exit 1; fi
rm pending
"$tool" --main
git merge-base --is-ancestor upstream/main HEAD
