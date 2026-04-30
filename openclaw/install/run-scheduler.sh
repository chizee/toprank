#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
python3 "$REPO_ROOT/openclaw/bin/run_scheduler.py" "$@"
