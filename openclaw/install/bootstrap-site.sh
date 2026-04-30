#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "$#" -ne 1 ]; then
  echo "usage: $0 <url-or-domain>" >&2
  exit 1
fi
python3 "$REPO_ROOT/openclaw/bin/bootstrap_site.py" "$1"
