#!/usr/bin/env bash
# Verify the exact release SHA + CI, then prepare and atomically activate on Hermes.
set -euo pipefail

HOST="${HOST:-hermes}"
DIR="${DIR:-/opt/aistudy}"
RELEASES_DIR="${RELEASES_DIR:-${DIR}-releases}"
CURRENT_LINK="${CURRENT_LINK:-${DIR}-current}"
DEPLOY_STATE="${DEPLOY_STATE:-${DIR}-deployment}"
BACKUP_DIR="${BACKUP_DIR:-${DIR}-backups}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
WORKER_CONFIG_DIR="${WORKER_CONFIG_DIR:-/etc/aistudy}"
MIN_FREE_KB="${MIN_FREE_KB:-4194304}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-deploy}"
[[ $# -le 1 ]] || { echo 'Only one deployment action is accepted.' >&2; exit 2; }
case "$ACTION" in deploy|status|logs|restart|rollback) ;; *) echo "Usage: $0 [deploy|status|logs|restart|rollback]" >&2; exit 2 ;; esac

fail() { echo "[!] $*" >&2; exit 1; }
quote() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
ssh_run() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
    "$HOST" "$1"
}

verify_release() {
  command -v gh >/dev/null || fail 'gh is required to verify the actual release CI result.'
  COMMIT="$(git rev-parse HEAD)"
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid release SHA.'
  [[ -z "$(git status --porcelain)" ]] || fail 'Deploy from a clean checkout of the merged release commit.'
  if [[ -z "${DEPLOY_REMOTE:-}" ]]; then
    DEPLOY_REMOTE=origin
    if git remote get-url study-assistant-opening >/dev/null 2>&1; then DEPLOY_REMOTE=study-assistant-opening; fi
  fi
  local remote_sha remote_url repository ci_url ci_json
  remote_sha="$(git ls-remote "$DEPLOY_REMOTE" refs/heads/feat/opening-release | cut -f1)"
  [[ "$COMMIT" == "$remote_sha" ]] || fail 'HEAD differs from the remote 发布主干 feat/opening-release.'
  remote_url="$(git remote get-url "$DEPLOY_REMOTE")"
  if [[ "$remote_url" =~ ^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]] \
    || [[ "$remote_url" =~ ^git@github\.com:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]]; then
    repository="${BASH_REMATCH[1]%.git}"
  else
    fail 'The deployment remote must identify a GitHub repository for CI verification.'
  fi
  ci_json="$(gh api "repos/$repository/actions/workflows/ci.yml/runs?head_sha=$COMMIT&branch=feat%2Fopening-release&event=push&per_page=100")" \
    || fail 'Could not read the actual CI result.'
  ci_url="$(printf '%s' "$ci_json" | node "$SCRIPT_DIR/hermes-ci.mjs" "$COMMIT" "$repository")" \
    || fail 'The latest push CI run for this exact release SHA has not succeeded.'
  printf 'Verified release %s\nCI: %s\n' "$COMMIT" "$ci_url"
}

remote_archive=''
local_archive=''
cleanup() { [[ -z "$local_archive" ]] || rm -f -- "$local_archive"; }
trap cleanup EXIT
if [[ "$ACTION" == deploy ]]; then
  verify_release
  ssh_run true || fail 'Trusted SSH connection unavailable; no deployment was attempted.'
  local_archive="$(mktemp "${TMPDIR:-/tmp}/aistudy-source.XXXXXXXX.tar.gz")"
  git archive --format=tar.gz --output="$local_archive" "$COMMIT"
  remote_archive="$(ssh_run 'mktemp /tmp/aistudy-source.XXXXXXXX.tar.gz')"
  [[ "$remote_archive" =~ ^/tmp/aistudy-source\.[A-Za-z0-9]+\.tar\.gz$ ]] || fail 'Invalid remote staging path.'
  scp -q -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
    -- "$local_archive" "$HOST:$remote_archive"
fi

remote_command='bash -o pipefail -s --'
for value in "$ACTION" "$DIR" "$RELEASES_DIR" "$CURRENT_LINK" "$DEPLOY_STATE" "$BACKUP_DIR" "$SYSTEMD_DIR" "$WORKER_CONFIG_DIR" "$MIN_FREE_KB" "${COMMIT:-}" "$remote_archive"; do
  remote_command+=" $(quote "$value")"
done
ssh_run "$remote_command" < "$SCRIPT_DIR/hermes-release.sh"
