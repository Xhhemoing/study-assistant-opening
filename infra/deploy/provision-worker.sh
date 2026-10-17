#!/usr/bin/env bash
# Root-only provisioning. Does not start, stop or enable the worker.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/provision-worker.py" "$@"
