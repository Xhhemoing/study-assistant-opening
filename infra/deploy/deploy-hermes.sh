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
case "$ACTION" in deploy|status|logs|restart|rollback|repair-check|repair-pre-migration|complete-postmigration-check|complete-postmigration|complete-postmigration-reload-sample|complete-postmigration-archive-retained) ;; *) echo 'Unknown deployment action.' >&2; exit 2 ;; esac

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

verify_repair_git() {
  local baseline=6afaaa70d3467da4f17daaad44a99e2d36b9f991 path history
  [[ "$SCRIPT_DIR" == "$(git rev-parse --show-toplevel)/infra/deploy" ]] || fail 'Repair entry must come from this exact clean checkout.'
  [[ "$repository" == Xhhemoing/study-assistant-opening ]] || fail 'Repair requires the formal repository.'
  git merge-base --is-ancestor "$baseline" "$COMMIT" || fail 'Repair baseline is not an ancestor.'
  [[ "$baseline" != "$COMMIT" ]] || fail 'Repair requires new controls and an artifact at the same new commit.'
  # The independently fetched exact main and reviewed local Git graph, not an
  # artifact manifest or private operator note, establish control-only ancestry.
  # Check EVERY parent edge too: application changes reverted at tip are refused.
  history=$(git log --format= -m --name-only "$baseline..$COMMIT") || fail 'Could not inspect every repair parent diff.'
  while IFS= read -r path; do
    case "$path" in
      infra/deploy/hermes-entry.py|infra/deploy/hermes-db.mjs)
        [[ "$ACTION" == complete-postmigration* ]] || fail 'Additional control paths are completion-only.' ;;
      infra/deploy/deploy-hermes.sh|infra/deploy/hermes-peer-broker.py|infra/deploy/hermes-release.sh|infra/deploy/hermes-supervisor.mjs|infra/deploy/hermes-writer-control.mjs|infra/deploy/hermes-writer-state.py|infra/deploy/hermes-config-durability.mjs|tests/tooling/hermes-*.mjs|tests/tooling/hermes_*test.py) ;;
      *) fail 'Repair ancestry contains changes outside the reviewed control/test closure.' ;;
    esac
  done < <(printf '%s\n' "$history" | sort -u | grep -v '^$')
  git diff --quiet "$baseline" "$COMMIT" -- . ':!infra/deploy' ':!tests/tooling' || fail 'Repair application/migration bytes differ from baseline.'
}

# Execute reviewed Python bytes in memory over strict SSH: no remote entry
# extraction, temporary directory, chmod, transition, fsync or crash handler.
# This is eligibility scope only; it does not claim DB visibility or readiness.
if [[ "$ACTION" == repair-check ]]; then
  verify_release
  verify_repair_git
  [[ -n "$EXPLICIT_HOST" ]] || fail 'Explicit HOST is required for repair check.'
  check_code="import fcntl,types,sys
sources=$(python3 -c 'import json,sys; from pathlib import Path; print(json.dumps({name: (Path(sys.argv[1])/name).read_text() for name in ("hermes-trusted-loader.py", "hermes-writer-exec.py", "hermes-peer-broker.py", "hermes-writer-state.py")}))' "$SCRIPT_DIR")
bootstrap=types.ModuleType('bootstrap')
exec(sources['hermes-trusted-loader.py'], bootstrap.__dict__)
class MemorySourceLoader(bootstrap.SourceLoader):
    def verify(self):
        # Reviewed checkout bytes arrive over SSH, never as remote source files.
        # Keep the real loader/cache/dependency injection and exact inventory;
        # state and manager still use the descriptor-based DAC readers.
        if set(sources) != set(bootstrap.SOURCES) or any(not isinstance(value,str) for value in sources.values()):
            raise ValueError('Invalid memory source inventory')
        captured={name: (value.encode(),None) for name,value in sources.items()}
        if self.sources is not None and captured != self.sources:
            raise ValueError('Memory source inventory changed')
        self.sources=captured
loader=MemorySourceLoader('/reviewed-memory')
m=loader.load('hermes-writer-state.py')
fd=bootstrap.safe_open(sys.argv[1]+'/deploy.lock',private=True)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
print(m.json.dumps(m.repair_check(*sys.argv[1:])))"
  ssh_run "/usr/bin/python3 -I -S -B -c $(quote "$check_code") $(quote "$DEPLOY_STATE") $(quote "$CURRENT_LINK") $(quote "$SYSTEMD_DIR")"
  exit
fi

if [[ "$ACTION" == complete-postmigration* ]]; then
  # Controls follow the existing exact-main/clean/latest-push-CI Git trust path.
  # The payload remains the already verified signed e5 release and retained gzip.
  [[ -z "${PI_CODING_AGENT:-}${PI_SESSION_ID:-}${PI_SESSION_FILE:-}" ]] || fail 'Completion intake must run outside Pi in an independently authorized scope.'
  [[ "${COMPLETION_SCOPE:-}" == 20261110T081511-846613 && -n "$EXPLICIT_HOST" ]] || fail 'Explicit completion incident and HOST required.'
  [[ "${COMPLETION_RELEASE:-}" == "$RELEASES_DIR/e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf-"* && "${COMPLETION_ARCHIVE:-}" == /* ]] || fail 'Existing e5 release and retained gzip required.'
  for value in "$DIR" "$RELEASES_DIR" "$CURRENT_LINK" "$DEPLOY_STATE" "$BACKUP_DIR" "$SYSTEMD_DIR" "$WORKER_CONFIG_DIR" "$COMPLETION_RELEASE" "$COMPLETION_ARCHIVE"; do
    [[ "$value" =~ ^/[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)*$ && "$value" != *'/..'* ]] || fail 'Unsafe completion path.'
  done
  [[ "$MIN_FREE_KB" =~ ^[1-9][0-9]*$ && "$MIN_FREE_KB" -ge 6291456 && -z "$ARTIFACT_RUN_ID" && -z "$TARGET_SHA" ]] || fail 'Completion forbids artifact download/target override or lower capacity floor.'
  verify_release
  verify_repair_git
  if [[ "$ACTION" == complete-postmigration-check ]]; then
    check_code="$(node "$SCRIPT_DIR/../../tests/tooling/hermes-completion-precheck.mjs")"
    command='/usr/bin/python3 -I -S -B -'
    for value in "$DEPLOY_STATE" "$CURRENT_LINK" "$SYSTEMD_DIR" "$COMPLETION_RELEASE" "$DIR/.env.production" "$COMPLETION_ARCHIVE" "$WORKER_CONFIG_DIR"; do command+=" $(quote "$value")"; done
    ssh_run "$command" <<< "$check_code"
  else
    [[ "${COMPLETION_CONFIRM:-}" == complete-20261110T081511-846613-existing-e5 ]] || fail 'Explicit incident completion execution confirmation required.'
    controls=(hermes-release.sh hermes-supervisor.mjs hermes-config-durability.mjs hermes-db.mjs hermes-health.mjs hermes-writer-control.mjs hermes-trusted-loader.py hermes-writer-state.py hermes-writer-exec.py hermes-peer-broker.py)
    paths=(); for value in "${controls[@]}"; do paths+=("infra/deploy/$value"); done
    # Only reviewed committed controls, never a newly downloaded payload.
    control_archive="$(mktemp "${TMPDIR:-/tmp}/aistudy-completion.XXXXXXXX.tar.gz")"
    trap 'rm -f -- "$control_archive"' EXIT
    git -c core.autocrlf=false -c core.eol=lf -c tar.umask=0022 archive --format=tar.gz --output="$control_archive" "$COMMIT" "${paths[@]}"
    [[ $(wc -c < "$control_archive") -le 1048576 ]] || fail 'Completion control transport exceeds 1 MiB.'
    verify_release
    remote_command='entry=$(mktemp -d /tmp/aistudy-entry.XXXXXXXX) || exit; '
    remote_command+="/usr/bin/python3 -I -S -B -c $(quote "$(< "$SCRIPT_DIR/hermes-entry.py")") extract-git \"\$entry\" || exit; "
    mode=completion-launch
    if [[ "$ACTION" == complete-postmigration-reload-sample ]]; then mode=completion-reload-samples; fi
    if [[ "$ACTION" == complete-postmigration-archive-retained ]]; then mode=completion-retained-archive; fi
    remote_command+="node \"\$entry/hermes-supervisor.mjs\" $mode \"\$entry/hermes-release.sh\""
    for value in complete-postmigration "$DIR" "$RELEASES_DIR" "$CURRENT_LINK" "$DEPLOY_STATE" "$BACKUP_DIR" "$SYSTEMD_DIR" "$WORKER_CONFIG_DIR" "$MIN_FREE_KB" e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf "$COMPLETION_RELEASE" 4136bafe71484359263128af46d8ddadfe7e9e0227a0976d3f3858f3b9d2b0a0 "$COMPLETION_ARCHIVE"; do remote_command+=" $(quote "$value")"; done
    # Retain the private entry for the full independent service lifetime, even
    # on SSH loss. No caller EXIT trap may remove an executing service's controls.
    ssh_run "$remote_command" < "$control_archive"
  fi
  exit
fi

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
if [[ "$ACTION" == deploy || "$ACTION" == repair-pre-migration ]]; then
  verify_release
  if [[ "$ACTION" == repair-pre-migration ]]; then
    verify_repair_git
    [[ -n "$ARTIFACT_RUN_ID" ]] || fail 'Repair requires the attested new-commit artifact; source fallback is forbidden.'
  fi
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
    git -c core.autocrlf=false -c core.eol=lf -c tar.umask=0022 archive --format=tar.gz --output="$control_archive" "$COMMIT" infra/deploy
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
  remote_command='entry=$(mktemp -d /tmp/aistudy-entry.XXXXXXXX) || exit; trap '\''rm -rf -- "$entry"'\'' EXIT; '
  # The extractor is reviewed bootstrap text, not code read from the archive.
  remote_command+="/usr/bin/python3 -I -S -B -c $(quote "$(< "$SCRIPT_DIR/hermes-entry.py")") extract \"\$entry\" || exit; "
  remote_command+='node "$entry/hermes-supervisor.mjs" run "$entry/hermes-release.sh"'
  for value in "$ACTION" "$DIR" "$RELEASES_DIR" "$CURRENT_LINK" "$DEPLOY_STATE" "$BACKUP_DIR" "$SYSTEMD_DIR" "$WORKER_CONFIG_DIR" "$MIN_FREE_KB" "${COMMIT:-}" "$remote_archive" "$artifact_digest" "$remote_control"; do
    remote_command+=" $(quote "$value")"
  done
  /usr/bin/python3 -I -S -B "$SCRIPT_DIR/hermes-entry.py" pack "$SCRIPT_DIR" | ssh_run "$remote_command"
fi
