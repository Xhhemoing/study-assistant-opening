#!/usr/bin/env bash
# Runs on Hermes via deploy-hermes.sh. No in-place source deletion and no DB rollback.
set -euo pipefail
umask 077
[[ $# == 11 ]] || { echo 'Invalid release arguments.' >&2; exit 2; }
ACTION=$1 DIR=$2 RELEASES_DIR=$3 CURRENT=$4 STATE=$5 BACKUPS=$6 SYSTEMD=$7 WORKER_CONFIG=$8 MIN_FREE_KB=$9
COMMIT=${10} ARCHIVE=${11}
fail() { echo "[!] $*" >&2; exit 1; }
for path in "$DIR" "$RELEASES_DIR" "$CURRENT" "$STATE" "$BACKUPS" "$SYSTEMD" "$WORKER_CONFIG"; do
  [[ "$path" =~ ^/[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)*$ && "$path" != *'/..'* && "$path" != *'/.' ]] \
    || fail 'Deployment paths must be normalized absolute paths containing only safe path characters.'
done
[[ "$MIN_FREE_KB" =~ ^[1-9][0-9]*$ ]] || fail 'MIN_FREE_KB must be a positive integer.'
[[ "$CURRENT" != "$DIR" && "$RELEASES_DIR" != "$DIR" && "$STATE" != "$DIR" && "$BACKUPS" != "$DIR" ]] \
  || fail 'Release, pointer, state and backup paths must be separate from the legacy directory.'
[[ -d "$DIR" && -f "$DIR/.env.production" ]] || fail 'Stable legacy directory/configuration is missing.'
CONFIG="$DIR/.env.production"
WEB_OVERRIDE="$SYSTEMD/aistudy-web.service.d/50-aistudy-release.conf"
WORKER_REQUIRED=0
RECOVERY_REQUIRED=0
RECOVERY_TARGET=''
RECOVERY_STATE=''
WORKER_HELPER=''
RELEASE=''

atomic_link() {
  local target=$1 link=$2 temporary="${2}.next.$$"
  if [[ -e "$temporary" || -L "$temporary" ]]; then echo 'Unexpected temporary pointer already exists.' >&2; return 1; fi
  ln -s -- "$target" "$temporary" || return 1
  if ! mv -Tf -- "$temporary" "$link"; then
    rm -f -- "$temporary" || echo 'Could not remove this attempt’s temporary pointer.' >&2
    return 1
  fi
  return 0
}
validate_target() {
  local target=$1
  [[ "$target" == "$DIR" || "$target" == "$RELEASES_DIR/"* ]] || fail 'Release pointer escapes managed directories.'
  [[ -f "$target/apps/web/.next/standalone/apps/web/server.js" ]] || fail 'Release has no prepared standalone server.'
}
current_target() {
  [[ -L "$CURRENT" ]] || fail 'Current release pointer is missing or is not a symlink.'
  readlink -f -- "$CURRENT"
}
worker_required() {
  if systemctl is-active --quiet aistudy-worker.service || systemctl is-enabled --quiet aistudy-worker.service; then printf 1; else printf 0; fi
}
worker_command() {
  bash "$WORKER_HELPER" "$1" --state-dir "$2" --systemd-dir "$SYSTEMD" --config-dir "$WORKER_CONFIG"
}
snapshot_configuration() {
  local destination=$1
  mkdir -p -- "$destination"
  if [[ -f "$WEB_OVERRIDE" ]]; then cp -p -- "$WEB_OVERRIDE" "$destination/web-override"; else touch "$destination/web-override.absent"; fi
  worker_command --snapshot "$destination"
}
restore_configuration() {
  local saved=$1
  if systemctl is-active --quiet aistudy-worker.service; then systemctl stop aistudy-worker.service || return 1; fi
  if [[ -f "$saved/web-override" ]]; then
    mkdir -p -- "$(dirname -- "$WEB_OVERRIDE")" || return 1
    cp -p -- "$saved/web-override" "$WEB_OVERRIDE" || return 1
  elif [[ -f "$saved/web-override.absent" ]]; then
    rm -f -- "$WEB_OVERRIDE" || return 1
  else
    echo 'Missing web configuration snapshot.' >&2; return 1
  fi
  worker_command --restore "$saved" || return 1
  systemctl daemon-reload || return 1
  return 0
}
restart_services() {
  local required=$1
  [[ "$required" == 0 || "$required" == 1 ]] || return 1
  systemctl restart aistudy-web.service || return 1
  if [[ "$required" == 1 ]]; then systemctl restart aistudy-worker.service || return 1; fi
  return 0
}
health() {
  local required=$1 expected=$2 profile=${3:-}
  local body attempt
  local -a identity_args=("$CONFIG" "$expected" "$required")
  if [[ -n "$profile" ]]; then identity_args+=("$profile"); fi
  for attempt in {1..12}; do
    body=$(curl -fsS --max-time 5 http://127.0.0.1:18090/api/health 2>/dev/null || true)
    if [[ "$body" == *'"status":"ok"'* ]]; then
      if [[ "$required" == 1 ]] && ! systemctl is-active --quiet aistudy-worker.service; then return 1; fi
      [[ -f "$STATE/runtime-identity.mjs" ]] || { echo 'Runtime identity inspector is not installed; first complete a managed deployment.' >&2; return 1; }
      if node "$STATE/runtime-identity.mjs" "${identity_args[@]}"; then return 0; else return 1; fi
    fi
    sleep 2
  done
  echo 'Web/worker health check failed.' >&2
  return 1
}
finish() {
  local result=$1 rollback_result=0
  trap - EXIT INT TERM
  if [[ "$result" != 0 && "$RECOVERY_REQUIRED" == 1 ]]; then
    set +e
    echo 'Activation failed; restoring the previous release and service configuration.' >&2
    atomic_link "$RECOVERY_TARGET" "$CURRENT" || { echo 'Rollback pointer restoration failed.' >&2; rollback_result=1; }
    restore_configuration "$RECOVERY_STATE" || { echo 'Rollback service configuration restoration failed.' >&2; rollback_result=1; }
    restart_services "$(cat "$RECOVERY_STATE/worker-required")" || { echo 'Rollback service restart failed.' >&2; rollback_result=1; }
    health "$(cat "$RECOVERY_STATE/worker-required")" "$RECOVERY_TARGET" "$RECOVERY_STATE/worker-identity.json" || { echo 'Rollback health/identity verification failed.' >&2; rollback_result=1; }
    if [[ "$rollback_result" == 0 ]]; then
      atomic_link "$RECOVERY_STATE/worker-identity.json" "$STATE/current-identity" || rollback_result=1
    fi
    if [[ "$rollback_result" == 0 ]]; then echo 'Previous release restored; database migrations were retained.' >&2
    else echo 'Automatic application rollback failed; inspect the retained deployment state immediately.' >&2; fi
  fi
  if [[ -n "$ARCHIVE" && "$ARCHIVE" =~ ^/tmp/aistudy-source\.[A-Za-z0-9]+\.tar\.gz$ ]]; then rm -f -- "$ARCHIVE"; fi
  exit "$result"
}
trap 'finish $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

case "$ACTION" in deploy|restart|rollback) ;;
  status)
    target=$(current_target); validate_target "$target"
    printf 'Current: %s\nSHA: ' "$target"
    if [[ -f "$target/.release-sha" ]]; then cat "$target/.release-sha"; else printf 'unrecorded legacy release\n'; fi
    systemctl status aistudy-web.service --no-pager --lines=0
    profile=''
    if [[ -L "$STATE/current-identity" ]]; then profile=$(readlink -f -- "$STATE/current-identity"); fi
    health "$(worker_required)" "$target" "$profile"
    exit ;;
  logs) journalctl -u aistudy-web.service -u aistudy-worker.service -f -n 50 --no-pager; exit ;;
  *) fail 'Unknown remote deployment action.' ;;
esac

mkdir -p -- "$STATE"
chmod 700 -- "$STATE"
exec 9> "$STATE/deploy.lock"
flock -n 9 || fail 'Another deployment/restart/rollback is already running.'
if [[ ! -e "$CURRENT" && ! -L "$CURRENT" ]]; then
  validate_target "$DIR"
  atomic_link "$DIR" "$CURRENT"
fi
OLD_TARGET=$(current_target)
validate_target "$OLD_TARGET"
WORKER_REQUIRED=$(worker_required)
if [[ "$ACTION" == restart ]]; then
  restart_services "$WORKER_REQUIRED"
  profile=''
  if [[ -L "$STATE/current-identity" ]]; then profile=$(readlink -f -- "$STATE/current-identity"); fi
  health "$WORKER_REQUIRED" "$OLD_TARGET" "$profile"
  echo 'Current release restarted and healthy.'
  exit
fi

mkdir -p -- "$STATE/releases"
TRANSITION="$STATE/releases/$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir -- "$TRANSITION"
printf '%s\n' "$OLD_TARGET" > "$TRANSITION/from-target"
printf '%s\n' "$WORKER_REQUIRED" > "$TRANSITION/worker-required"
RECOVERY_TARGET=$OLD_TARGET
RECOVERY_STATE=$TRANSITION
if [[ "$ACTION" == rollback ]]; then
  [[ -L "$STATE/last-transition" ]] || fail 'No successful managed transition is available for rollback.'
  PREVIOUS_STATE=$(readlink -f -- "$STATE/last-transition")
  [[ "$PREVIOUS_STATE" == "$STATE/releases/"* && -f "$PREVIOUS_STATE/succeeded" ]] || fail 'Previous release metadata is incomplete.'
  RELEASE=$(cat "$PREVIOUS_STATE/from-target")
  validate_target "$RELEASE"
  [[ "$RELEASE" != "$OLD_TARGET" ]] || fail 'Rollback target equals the current release.'
  WORKER_HELPER="$OLD_TARGET/infra/deploy/provision-worker.sh"
  if [[ ! -f "$WORKER_HELPER" ]]; then WORKER_HELPER="$RELEASE/infra/deploy/provision-worker.sh"; fi
  [[ -f "$WORKER_HELPER" ]] || fail 'Current release has no worker configuration recovery helper.'
  node "$STATE/runtime-identity.mjs" capture "$CONFIG" "$OLD_TARGET" "$WORKER_REQUIRED" "$TRANSITION/worker-identity.json"
  snapshot_configuration "$TRANSITION"
  RECOVERY_REQUIRED=1
  restore_configuration "$PREVIOUS_STATE"
  atomic_link "$RELEASE" "$CURRENT"
  restart_services "$(cat "$PREVIOUS_STATE/worker-required")"
  health "$(cat "$PREVIOUS_STATE/worker-required")" "$RELEASE" "$PREVIOUS_STATE/worker-identity.json"
else
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ && "$ARCHIVE" =~ ^/tmp/aistudy-source\.[A-Za-z0-9]+\.tar\.gz$ && -f "$ARCHIVE" ]] \
    || fail 'Verified release SHA/archive is missing.'
  mkdir -p -- "$RELEASES_DIR" "$BACKUPS"
  chmod 755 -- "$RELEASES_DIR"
  chmod 700 -- "$BACKUPS"
  for path in "$RELEASES_DIR" "$BACKUPS"; do
    available=$(df -Pk -- "$path" | awk 'NR == 2 { print $4 }')
    [[ "$available" =~ ^[0-9]+$ && "$available" -ge "$MIN_FREE_KB" ]] || fail 'Insufficient free disk space; live files and backups were retained.'
  done
  RELEASE="$RELEASES_DIR/$COMMIT-$(date -u +%Y%m%dT%H%M%S)-$$"
  mkdir -m 755 -- "$RELEASE"
  tar -xzf "$ARCHIVE" -C "$RELEASE"
  chmod -R a+rX -- "$RELEASE"
  ln -s -- "$CONFIG" "$RELEASE/.env.production"
  node "$RELEASE/infra/deploy/hermes-health.mjs" capture "$CONFIG" "$OLD_TARGET" "$WORKER_REQUIRED" "$TRANSITION/worker-identity.json"
  cd -- "$RELEASE"
  npm ci --no-audit --no-fund > "$TRANSITION/install.log" 2>&1
  npm run build > "$TRANSITION/build.log" 2>&1
  mkdir -p apps/web/.next/standalone/apps/web/.next/static apps/web/.next/standalone/apps/web/public
  cp -a apps/web/.next/static/. apps/web/.next/standalone/apps/web/.next/static/
  if [[ -d apps/web/public ]]; then cp -a apps/web/public/. apps/web/.next/standalone/apps/web/public/; fi
  validate_target "$RELEASE"
  [[ -n "$(find apps/web/.next/standalone/apps/web/.next/static -type f -print -quit)" ]] || fail 'Standalone static assets are missing.'
  cp -- "$RELEASE/infra/deploy/hermes-health.mjs" "$STATE/runtime-identity.mjs.next"
  mv -Tf -- "$STATE/runtime-identity.mjs.next" "$STATE/runtime-identity.mjs"
  node "$RELEASE/infra/deploy/hermes-db.mjs" parser "$CONFIG" "$RELEASE" "$DIR/.local/docling-venv/bin/python" "$DIR"
  BACKUP="$BACKUPS/$(basename -- "$RELEASE").dump"
  node "$RELEASE/infra/deploy/hermes-db.mjs" backup "$CONFIG" "$BACKUP"
  printf '%s\n' "$BACKUP" > "$TRANSITION/database-backup"
  node "$RELEASE/infra/deploy/hermes-db.mjs" migrate "$CONFIG" "$RELEASE"
  touch "$TRANSITION/migration-succeeded"
  printf '%s\n' "$COMMIT" > "$RELEASE/.release-sha"
  WORKER_HELPER="$RELEASE/infra/deploy/provision-worker.sh"
  [[ -f "$WORKER_HELPER" ]] || fail 'Release worker provisioning helper is missing.'
  snapshot_configuration "$TRANSITION"
  RECOVERY_REQUIRED=1
  bash "$WORKER_HELPER" --app-dir "$CURRENT" --release-dir "$RELEASE" --legacy-app-dir "$DIR" \
    --config-file "$CONFIG" --state-dir "$TRANSITION" --systemd-dir "$SYSTEMD" --config-dir "$WORKER_CONFIG" \
    --parser-python "$DIR/.local/docling-venv/bin/python"
  mkdir -p -- "$(dirname -- "$WEB_OVERRIDE")"
  cat > "$WEB_OVERRIDE" <<UNIT
[Service]
WorkingDirectory=$CURRENT
EnvironmentFile=$CONFIG
ExecStart=
ExecStart=/usr/bin/node $CURRENT/apps/web/.next/standalone/apps/web/server.js
UNIT
  chmod 644 -- "$WEB_OVERRIDE"
  systemctl daemon-reload
  atomic_link "$RELEASE" "$CURRENT"
  restart_services "$WORKER_REQUIRED"
  health "$WORKER_REQUIRED" "$RELEASE"
fi
printf '%s\n' "$RELEASE" > "$TRANSITION/to-target"
touch "$TRANSITION/succeeded"
if [[ "$ACTION" == rollback ]]; then
  atomic_link "$PREVIOUS_STATE/worker-identity.json" "$STATE/current-identity"
else
  rm -f -- "$STATE/current-identity"
fi
atomic_link "$TRANSITION" "$STATE/last-transition"
RECOVERY_REQUIRED=0
printf '部署完成: %s (%s)\n' "$RELEASE" "$ACTION"
