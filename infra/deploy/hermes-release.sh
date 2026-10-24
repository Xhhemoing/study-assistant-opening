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
WORKER_GUARD="$SYSTEMD/aistudy-worker.service.d/90-aistudy-protocol-guard.conf"
WORKER_PROTOCOL='delivery-leases-v1'
INCOMPLETE="$STATE/activation-incomplete"
WORKER_REQUIRED=0
RECOVERY_REQUIRED=0
RECOVERY_TARGET=''
RECOVERY_STATE=''
WORKER_HELPER=''
RELEASE=''
TRANSITION=''
DEGRADED=0

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
  # Retain the original managed root when new releases move to another disk,
  # so both preflight and rollback still recognize the previous application.
  [[ "$target" == "$DIR" || "$target" == "$RELEASES_DIR/"* || "$target" == "${DIR}-releases/"* ]] \
    || fail 'Release pointer escapes managed directories.'
  [[ -f "$target/apps/web/.next/standalone/apps/web/server.js" ]] || fail 'Release has no prepared standalone server.'
}
current_target() {
  [[ -L "$CURRENT" ]] || fail 'Current release pointer is missing or is not a symlink.'
  readlink -f -- "$CURRENT"
}
worker_required() {
  local marker intended
  if systemctl is-active --quiet aistudy-worker.service || systemctl is-enabled --quiet aistudy-worker.service; then printf 1; return; fi
  if [[ -L "$CURRENT" ]]; then
    marker=$(worker_pause_file "$(current_target)") || return 1
    if [[ ! -f "$marker" && -f "$WORKER_GUARD" ]]; then
      # A partial recovery may have restored CURRENT but not its unit. Preserve
      # the intent stored behind the still-active legacy guard in that case.
      marker=$(sed -n 's/^ConditionPathExists=!//p' "$WORKER_GUARD")
      [[ "$marker" == "$STATE/worker-pauses/"*.pause ]] || marker=''
    fi
    if [[ -f "$marker" ]]; then
      IFS= read -r intended < "$marker"
      if [[ "$intended" == 1 ]]; then printf 1; return; fi
    fi
  fi
  printf 0
}
begin_activation() {
  printf '%s\n' "$TRANSITION" > "$INCOMPLETE.next.$$"
  mv -Tf -- "$INCOMPLETE.next.$$" "$INCOMPLETE"
}
report_incomplete() {
  echo 'INCOMPLETE: deployment/rollback activation did not complete; inspect the current pointer and service configuration before restarting.' >&2
}
lease_worker() {
  [[ -f "$1/.worker-protocol" ]] || return 1
  case "$(cat "$1/.worker-protocol")" in delivery-leases-v1|delivery-leases-study-v1|delivery-leases-study-v2) return 0 ;; *) return 1 ;; esac
}
study_release() {
  [[ -f "$1/.worker-protocol" ]] || return 1
  case "$(cat "$1/.worker-protocol")" in delivery-leases-study-v1|delivery-leases-study-v2) return 0 ;; *) return 1 ;; esac
}
study_v2_release() {
  [[ -f "$1/.worker-protocol" && "$(cat "$1/.worker-protocol")" == delivery-leases-study-v2 ]]
}
worker_pause_file() {
  local hash
  hash=$(printf '%s' "$1" | sha256sum) || return 1
  printf '%s/worker-pauses/%s.pause' "$STATE" "${hash%% *}"
}
worker_paused() {
  local marker
  marker=$(worker_pause_file "$1") || return 1
  [[ -f "$marker" ]]
}
install_worker_guard() {
  local marker temporary="$WORKER_GUARD.next.$$"
  marker=$(worker_pause_file "$1") || return 1
  mkdir -p -- "$(dirname -- "$WORKER_GUARD")" || return 1
  # This owned drop-in also blocks enabled services at boot and direct starts.
  # Other drop-ins are retained. Pause records survive configuration rollback.
  printf '[Unit]\nConditionPathExists=!%s\n' "$marker" > "$temporary" || return 1
  chmod 644 -- "$temporary" || return 1
  mv -Tf -- "$temporary" "$WORKER_GUARD" || return 1
  systemctl daemon-reload || return 1
}
pause_worker() {
  local marker temporary
  marker=$(worker_pause_file "$1") || return 1
  temporary="$marker.next.$$"
  mkdir -p -- "$STATE/worker-pauses" || return 1
  chmod 700 -- "$STATE/worker-pauses" || return 1
  if [[ ! -f "$marker" ]]; then
    printf '%s\nTarget: %s\nTransition: %s\nReason: lease worker may have executed; reconcile interrupted work before legacy startup.\n' "$2" "$1" "$TRANSITION" > "$temporary" || return 1
    mv -Tf -- "$temporary" "$marker" || return 1
  fi
  return 0
}
report_worker_pause() {
  echo "DEGRADED: web restored; legacy worker remains stopped. Administrator reconciliation is required before removing $(worker_pause_file "$1")." >&2
}
restoration_worker_requirement() {
  local target=$1 required=$2 saved=$3
  if [[ -f "$saved/study-v2-app-start-attempted" ]] && ! study_v2_release "$target"; then
    echo 'Refusing recovery to an application without Study text-question and photo-recognition support after Study v2 startup; retain the compatible release and inspect the incomplete activation.' >&2
    return 1
  fi
  if [[ -f "$saved/study-app-start-attempted" ]] && ! study_release "$target"; then
    echo 'Refusing recovery to a pre-Study application after Study Web startup; retain the compatible release and inspect the incomplete activation.' >&2
    return 1
  fi
  if ! lease_worker "$target" && [[ -f "$saved/lease-worker-start-attempted" ]]; then
    pause_worker "$target" "$required" || return 1
  fi
  if worker_paused "$target"; then
    # A failed activation may already have pointed the guard at its new target.
    # Restore the persistent legacy condition before restoring the old pointer.
    install_worker_guard "$target" || return 1
    printf 0
  else printf '%s' "$required"; fi
}
worker_command() {
  bash "$WORKER_HELPER" "$1" --state-dir "$2" --systemd-dir "$SYSTEMD" --config-dir "$WORKER_CONFIG"
}
stop_worker() {
  local load_state
  if ! load_state=$(systemctl show --property=LoadState --value aistudy-worker.service); then
    [[ "$load_state" == not-found ]] || return 1
  fi
  [[ -n "$load_state" ]] || return 1
  # A failed/auto-restart unit may be inactive now and still start later.
  # stop cancels that pending restart; first installation has no unit to stop.
  if [[ "$load_state" != not-found ]]; then systemctl stop aistudy-worker.service || return 1; fi
  if systemctl is-active --quiet aistudy-worker.service; then
    echo 'Worker may still be active; manual service intervention is required.' >&2
    return 1
  fi
}
snapshot_configuration() {
  local destination=$1
  mkdir -p -- "$destination"
  if [[ -f "$WEB_OVERRIDE" ]]; then cp -p -- "$WEB_OVERRIDE" "$destination/web-override"; else touch "$destination/web-override.absent"; fi
  if [[ -f "$WORKER_GUARD" ]]; then cp -p -- "$WORKER_GUARD" "$destination/worker-protocol-guard.before"; else touch "$destination/worker-protocol-guard.before.absent"; fi
  worker_command --snapshot "$destination"
}
restore_configuration() {
  local saved=$1
  stop_worker || return 1
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
  local required=$1 target=$2
  [[ "$required" == 0 || "$required" == 1 ]] || return 1
  install_worker_guard "$target" || return 1
  # Web can persist Study answer conditions even when the worker is disabled.
  if study_release "$target" && [[ -n "$TRANSITION" ]]; then touch "$TRANSITION/study-app-start-attempted" || return 1; fi
  # 0091 pasted questions and 0092 recognition jobs are unreadable by Study v1.
  # Persist before either process can run, including a failed startup command.
  if study_v2_release "$target" && [[ -n "$TRANSITION" ]]; then touch "$TRANSITION/study-v2-app-start-attempted" || return 1; fi
  systemctl restart aistudy-web.service || return 1
  if [[ "$required" == 1 ]]; then
    if worker_paused "$target"; then report_worker_pause "$target"; return 1; fi
    # A failed restart may already have executed work. Persist before the call.
    if lease_worker "$target" && [[ -n "$TRANSITION" ]]; then touch "$TRANSITION/lease-worker-start-attempted" || return 1; fi
    systemctl restart aistudy-worker.service || return 1
  fi
  return 0
}
health() {
  local required=$1 expected=$2 profile=${3:-}
  local body attempt
  local -a identity_args=("$CONFIG" "$expected" "$required")
  if [[ -n "$profile" ]]; then identity_args+=("$profile"); fi
  # Cold parser imports + OCR probe can exceed two minutes. Readiness, not
  # systemd active, controls success; a bounded retry also covers startup backoff.
  for attempt in {1..120}; do
    body=$(curl -fsS --max-time 5 http://127.0.0.1:18090/api/health 2>/dev/null || true)
    if [[ "$body" == *'"status":"ok"'* ]]; then
      if [[ "$required" == 1 ]] && ! systemctl is-active --quiet aistudy-worker.service; then return 1; fi
      [[ -f "$STATE/runtime-identity.mjs" ]] || { echo 'Runtime identity inspector is not installed; first complete a managed deployment.' >&2; return 1; }
      if node "$STATE/runtime-identity.mjs" "${identity_args[@]}"; then return 0; fi
    fi
    sleep 2
  done
  echo 'Web/worker health check failed.' >&2
  return 1
}
finish() {
  local result=$1 rollback_result=0 restored_required can_restore=1
  trap - EXIT INT TERM
  if [[ "$result" != 0 && "$RECOVERY_REQUIRED" == 1 ]]; then
    set +e
    echo 'Activation failed; restoring the previous release and service configuration.' >&2
    stop_worker || { rollback_result=1; can_restore=0; }
    if [[ "$can_restore" == 1 ]]; then
      restored_required=$(restoration_worker_requirement "$RECOVERY_TARGET" "$(cat "$RECOVERY_STATE/worker-required")" "$RECOVERY_STATE") || { rollback_result=1; can_restore=0; }
    fi
    if [[ "$can_restore" == 1 ]]; then
      atomic_link "$RECOVERY_TARGET" "$CURRENT" || { echo 'Rollback pointer restoration failed.' >&2; rollback_result=1; can_restore=0; }
    fi
    if [[ "$can_restore" == 1 ]]; then
      # Keep any legacy pause condition until BOTH pointer and unit are back.
      # The old unit may use an absolute legacy path independent of CURRENT.
      restore_configuration "$RECOVERY_STATE" || { echo 'Rollback service configuration restoration failed.' >&2; rollback_result=1; can_restore=0; }
    fi
    if [[ "$can_restore" == 1 ]]; then
      restart_services "$restored_required" "$RECOVERY_TARGET" || { echo 'Rollback service restart failed.' >&2; rollback_result=1; }
      health "$restored_required" "$RECOVERY_TARGET" "$RECOVERY_STATE/worker-identity.json" || { echo 'Rollback health/identity verification failed.' >&2; rollback_result=1; }
    else
      echo 'Rollback activation halted; inspect the current pointer and service configuration before manual intervention.' >&2
    fi
    if [[ "$rollback_result" == 0 ]]; then
      atomic_link "$RECOVERY_STATE/worker-identity.json" "$STATE/current-identity" || rollback_result=1
    fi
    if [[ "$rollback_result" == 0 ]]; then rm -f -- "$INCOMPLETE" || rollback_result=1; fi
    if [[ "$rollback_result" == 0 ]] && worker_paused "$RECOVERY_TARGET"; then report_worker_pause "$RECOVERY_TARGET"
    elif [[ "$rollback_result" == 0 ]]; then echo 'Previous release restored; database migrations were retained.' >&2
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
    if [[ -f "$INCOMPLETE" ]]; then report_incomplete; exit 3; fi
    systemctl status aistudy-web.service --no-pager --lines=0
    profile=''
    if [[ -L "$STATE/current-identity" ]]; then profile=$(readlink -f -- "$STATE/current-identity"); fi
    if worker_paused "$target"; then
      health 0 "$target" "$profile"
      report_worker_pause "$target"
      exit 3
    fi
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
  if [[ -f "$INCOMPLETE" ]]; then report_incomplete; exit 3; fi
  if worker_paused "$OLD_TARGET"; then report_worker_pause "$OLD_TARGET"; exit 3; fi
  restart_services "$WORKER_REQUIRED" "$OLD_TARGET"
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
  [[ "$PREVIOUS_STATE" == "$STATE/releases/"* && ( -f "$PREVIOUS_STATE/succeeded" || -f "$PREVIOUS_STATE/degraded" ) ]] || fail 'Previous release metadata is incomplete.'
  RELEASE=$(cat "$PREVIOUS_STATE/from-target")
  validate_target "$RELEASE"
  if study_v2_release "$OLD_TARGET" && ! study_v2_release "$RELEASE"; then
    fail 'Refusing rollback to an application without Study text-question and photo-recognition support; keep a Study v2 release.'
  fi
  if study_release "$OLD_TARGET" && ! study_release "$RELEASE"; then
    fail 'Refusing rollback to a pre-Study application; use a release that preserves Study answer conditions.'
  fi
  [[ "$RELEASE" != "$OLD_TARGET" ]] || fail 'Rollback target equals the current release.'
  WORKER_HELPER="$OLD_TARGET/infra/deploy/provision-worker.sh"
  if [[ ! -f "$WORKER_HELPER" ]]; then WORKER_HELPER="$RELEASE/infra/deploy/provision-worker.sh"; fi
  [[ -f "$WORKER_HELPER" ]] || fail 'Current release has no worker configuration recovery helper.'
  node "$STATE/runtime-identity.mjs" capture "$CONFIG" "$OLD_TARGET" "$WORKER_REQUIRED" "$TRANSITION/worker-identity.json"
  snapshot_configuration "$TRANSITION"
  RECOVERY_REQUIRED=1
  begin_activation
  # A managed source release may already have executed work, even if inactive.
  if lease_worker "$OLD_TARGET"; then touch "$TRANSITION/lease-worker-start-attempted"; fi
  stop_worker
  RESTORED_REQUIRED=$(restoration_worker_requirement "$RELEASE" "$(cat "$PREVIOUS_STATE/worker-required")" "$TRANSITION")
  restore_configuration "$PREVIOUS_STATE"
  atomic_link "$RELEASE" "$CURRENT"
  restart_services "$RESTORED_REQUIRED" "$RELEASE"
  health "$RESTORED_REQUIRED" "$RELEASE" "$PREVIOUS_STATE/worker-identity.json"
  if worker_paused "$RELEASE"; then DEGRADED=1; fi
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
  # The version travels with the reviewed source. Unmarked historical archives
  # retain their original delivery-leases protocol, never acquire Study support.
  release_protocol=$WORKER_PROTOCOL
  if [[ -f "$RELEASE/.worker-protocol" ]]; then release_protocol=$(cat "$RELEASE/.worker-protocol"); fi
  case "$release_protocol" in delivery-leases-v1|delivery-leases-study-v1|delivery-leases-study-v2) ;; *) fail 'Unknown release data protocol.' ;; esac
  if study_v2_release "$OLD_TARGET" && ! study_v2_release "$RELEASE"; then
    fail 'Refusing deployment of an application without Study text-question and photo-recognition support; keep a Study v2 release.'
  fi
  if study_release "$OLD_TARGET" && ! study_release "$RELEASE"; then
    fail 'Refusing deployment of a pre-Study application; preserve Study answer conditions.'
  fi
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
  WORKER_HELPER="$RELEASE/infra/deploy/provision-worker.sh"
  [[ -f "$WORKER_HELPER" ]] || fail 'Release worker provisioning helper is missing.'
  snapshot_configuration "$TRANSITION"
  RECOVERY_REQUIRED=1
  begin_activation
  # Claim-token fencing changes the worker write protocol. Drain/stop the old
  # process before migrating so unfenced code cannot write across the transition.
  stop_worker
  node "$RELEASE/infra/deploy/hermes-db.mjs" migrate "$CONFIG" "$RELEASE"
  touch "$TRANSITION/migration-succeeded"
  printf '%s\n' "$COMMIT" > "$RELEASE/.release-sha"
  printf '%s\n' "$release_protocol" > "$RELEASE/.worker-protocol"
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
  restart_services "$WORKER_REQUIRED" "$RELEASE"
  health "$WORKER_REQUIRED" "$RELEASE"
fi
printf '%s\n' "$RELEASE" > "$TRANSITION/to-target"
if [[ "$DEGRADED" == 1 ]]; then touch "$TRANSITION/degraded"; else touch "$TRANSITION/succeeded"; fi
if [[ "$ACTION" == rollback ]]; then
  atomic_link "$PREVIOUS_STATE/worker-identity.json" "$STATE/current-identity"
else
  rm -f -- "$STATE/current-identity"
fi
atomic_link "$TRANSITION" "$STATE/last-transition"
rm -f -- "$INCOMPLETE"
RECOVERY_REQUIRED=0
if [[ "$DEGRADED" == 1 ]]; then report_worker_pause "$RELEASE"; exit 3; fi
printf '部署完成: %s (%s)\n' "$RELEASE" "$ACTION"
