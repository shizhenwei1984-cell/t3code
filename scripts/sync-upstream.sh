#!/usr/bin/env bash
# Merge upstream into this fork's customization branch, retaining personal commits.
set -euo pipefail
if [[ ${1:-} == --install || ${1:-} == --rollback ]]; then
  exec "$(dirname "$0")/personal-update.sh" "$@"
fi
main=false
push=false
for arg in "$@"; do
  case "$arg" in
    --main) main=true ;;
    --push) push=true ;;
    -h|--help) echo "Usage: scripts/sync-upstream.sh [--main] [--push] | --install [--push] | --rollback"; exit 0 ;;
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
  latest=${T3_PERSONAL_STABLE_TAG:-$(git ls-remote --tags --refs upstream 'v*' | awk -F/ '$NF ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ {print $NF}' | sort -V | tail -n 1)}
  [[ $latest =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Upstream has no stable version tag." >&2; exit 1; }
  target=refs/tags/$latest
  git fetch upstream "$target:$target"
fi
git merge --no-edit "$target"
if "$push"; then git push origin "HEAD:refs/heads/$branch"; fi
