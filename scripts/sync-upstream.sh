#!/usr/bin/env bash
# Merge upstream into this fork's customization branch, retaining personal commits.
set -euo pipefail
main=false
push=false
for arg in "$@"; do
  case "$arg" in
    --main) main=true ;;
    --push) push=true ;;
    -h|--help) echo "Usage: scripts/sync-upstream.sh [--main] [--push]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
branch=feature/cursor-on-demand
[[ $(git branch --show-current) == "$branch" ]] || { echo "Switch to $branch first." >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo "Commit or stash local changes first." >&2; exit 1; }
git fetch origin
if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git merge --no-edit "refs/remotes/origin/$branch"
fi
if "$main"; then
  git fetch upstream refs/heads/main:refs/remotes/upstream/main
  target=refs/remotes/upstream/main
else
  latest=$(git ls-remote --tags --refs upstream 'v*' | awk -F/ '$NF ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ {print $NF}' | sort -V | tail -n 1)
  [[ -n $latest ]] || { echo "Upstream has no stable version tag." >&2; exit 1; }
  target=refs/tags/$latest
  git fetch upstream "$target:$target"
fi
git merge --no-edit "$target"
if "$push"; then git push origin "HEAD:refs/heads/$branch"; fi
