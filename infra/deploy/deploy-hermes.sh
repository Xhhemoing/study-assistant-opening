#!/usr/bin/env bash
# Verify the exact release SHA + CI, then prepare and atomically activate on Hermes.
set -euo pipefail

EXPLICIT_HOST="${HOST:-}"
HOST="${HOST:-hermes}"
DIR="${DIR:-/opt/aistudy}"
RELEASES_DIR="${RELEASES_DIR:-${DIR}-releases}"
CURRENT_LINK="${CURRENT_LINK:-${DIR}-current}"
DEPLOY_STATE="${DEPLOY_STATE:-${DIR}-deployment}"
BACKUP_DIR="${BACKUP_DIR:-${DIR}-backups}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
WORKER_CONFIG_DIR="${WORKER_CONFIG_DIR:-/etc/aistudy}"
MIN_FREE_KB="${MIN_FREE_KB:-6291456}"
ARTIFACT_RUN_ID="${ARTIFACT_RUN_ID:-}"
TARGET_SHA="${TARGET_SHA:-}"
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
  local remote_sha remote_url ci_json
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
artifact_directory=''
control_archive=''
remote_control=''
artifact_digest=''
cleanup() {
  [[ -z "$local_archive" ]] || rm -f -- "$local_archive"
  [[ -z "$control_archive" ]] || rm -f -- "$control_archive"
  [[ -z "$artifact_directory" ]] || rm -rf -- "$artifact_directory"
}
trap cleanup EXIT
if [[ "$ACTION" == deploy ]]; then
  verify_release
  if [[ -n "$ARTIFACT_RUN_ID" ]]; then
    [[ "$ARTIFACT_RUN_ID" =~ ^[1-9][0-9]*$ && "$TARGET_SHA" == "$COMMIT" ]] || fail 'Artifact deployment requires explicit run ID and matching TARGET_SHA.'
    [[ "$repository" == Xhhemoing/study-assistant-opening ]] || fail 'Artifact source must be the formal repository.'
    [[ -n "$EXPLICIT_HOST" ]] || fail 'Explicit HOST is required for artifact deployment.'
    [[ "$MIN_FREE_KB" =~ ^[1-9][0-9]*$ && "$MIN_FREE_KB" -ge 6291456 ]] || fail 'Artifact mode requires at least 6 GiB free space.'
    artifact_directory="$(mktemp -d "${TMPDIR:-/tmp}/aistudy-download.XXXXXXXX")"
    artifact_digest="$(node "$SCRIPT_DIR/verify-release-artifact.mjs" download "$COMMIT" "$ARTIFACT_RUN_ID" "$artifact_directory/payload")" || fail 'Artifact provenance verification failed; no rebuild fallback.'
    local_archive="$artifact_directory/payload/release.tar.gz"
    # Control-plane scripts come from reviewed Git, NOT from the downloaded blob.
    control_archive="$(mktemp "${TMPDIR:-/tmp}/aistudy-control.XXXXXXXX.tar.gz")"
    git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz --output="$control_archive" "$COMMIT" infra/deploy
    [[ "$(git ls-remote "$DEPLOY_REMOTE" refs/heads/feat/opening-release | cut -f1)" == "$COMMIT" ]] || fail 'Release tip changed while verifying artifact.'
  else
    [[ -z "$TARGET_SHA" || "$TARGET_SHA" == "$COMMIT" ]] || fail 'TARGET_SHA differs from HEAD.'
    local_archive="$(mktemp "${TMPDIR:-/tmp}/aistudy-source.XXXXXXXX.tar.gz")"
    # Committed bytes only, without local CRLF conversion.
    git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz --output="$local_archive" "$COMMIT"
  fi
  ssh_run true || fail 'Trusted SSH connection unavailable; no deployment was attempted.'
  remote_archive="$(ssh_run 'mktemp /tmp/aistudy-source.XXXXXXXX.tar.gz')"
  [[ "$remote_archive" =~ ^/tmp/aistudy-source\.[A-Za-z0-9]+\.tar\.gz$ ]] || fail 'Invalid remote staging path.'
  scp -q -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
    -- "$local_archive" "$HOST:$remote_archive"
  if [[ -n "$ARTIFACT_RUN_ID" ]]; then
    remote_control="$(ssh_run 'mktemp /tmp/aistudy-control.XXXXXXXX.tar.gz')"
    [[ "$remote_control" =~ ^/tmp/aistudy-control\.[A-Za-z0-9]+\.tar\.gz$ ]] || fail 'Invalid remote control path.'
    scp -q -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -- "$control_archive" "$HOST:$remote_control"
    # Repeat latest CI and tip verification immediately before the managed transition.
    verify_release
    [[ "$TARGET_SHA" == "$COMMIT" && "$ci_url" == "https://github.com/Xhhemoing/study-assistant-opening/actions/runs/$ARTIFACT_RUN_ID" ]] || fail 'Target/latest CI changed.'
  fi
fi

remote_command='bash -o pipefail -s --'
for value in "$ACTION" "$DIR" "$RELEASES_DIR" "$CURRENT_LINK" "$DEPLOY_STATE" "$BACKUP_DIR" "$SYSTEMD_DIR" "$WORKER_CONFIG_DIR" "$MIN_FREE_KB" "${COMMIT:-}" "$remote_archive" "$artifact_digest" "$remote_control"; do
  remote_command+=" $(quote "$value")"
done
if [[ "$ACTION" == status || "$ACTION" == logs ]]; then
  ssh_run "$remote_command" < "$SCRIPT_DIR/hermes-release.sh"
else
  # The reviewed entry owns both supervisor and owner bytes. No remote installed
  # helper or operator-started systemctl process is needed for crash fencing.
  remote_command='entry=$(mktemp -d /tmp/aistudy-entry.XXXXXXXX) || exit; trap '\''rm -rf -- "$entry"'\'' EXIT; tar -xzf - -C "$entry" || exit; node "$entry/hermes-supervisor.mjs" run "$entry/hermes-release.sh"'
  for value in "$ACTION" "$DIR" "$RELEASES_DIR" "$CURRENT_LINK" "$DEPLOY_STATE" "$BACKUP_DIR" "$SYSTEMD_DIR" "$WORKER_CONFIG_DIR" "$MIN_FREE_KB" "${COMMIT:-}" "$remote_archive" "$artifact_digest" "$remote_control"; do
    remote_command+=" $(quote "$value")"
  done
  tar -czf - -C "$SCRIPT_DIR" hermes-release.sh hermes-supervisor.mjs hermes-db.mjs | ssh_run "$remote_command"
fi
