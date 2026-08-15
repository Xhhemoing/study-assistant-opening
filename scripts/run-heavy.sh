#!/usr/bin/env bash
# Serialize and de-prioritize expensive validation tasks on the small shared VM.
set -euo pipefail

lock_file="${HERMES_HEAVY_LOCK:-/tmp/hermes-project-heavy.lock}"
mkdir -p "$(dirname "$lock_file")"

if [[ "${HERMES_HEAVY_LOCK_HELD:-0}" != 1 ]]; then
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock_file"
    if ! flock -w "${HERMES_HEAVY_LOCK_TIMEOUT:-120}" 9; then
      echo "Another project validation task is running; refusing to overlap." >&2
      exit 75
    fi
    export HERMES_HEAVY_LOCK_HELD=1
  else
    echo "[heavy-task] flock unavailable; running without cross-process locking." >&2
  fi
fi

run=("$@")
if command -v nice >/dev/null 2>&1; then
  run=(nice -n "${HERMES_HEAVY_NICE:-12}" "${run[@]}")
fi
if command -v ionice >/dev/null 2>&1; then
  run=(ionice -c 3 "${run[@]}")
fi
if command -v taskset >/dev/null 2>&1 && taskset -c 0 true >/dev/null 2>&1; then
  run=(taskset -c 0 "${run[@]}")
fi

echo "[heavy-task] running with available host scheduling controls: $*" >&2
exec "${run[@]}"
