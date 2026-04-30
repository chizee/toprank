#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON_BIN="$(command -v python3)"
LABEL="com.noworkstudio.toprank.openclaw.scheduler"
INTERVAL=3600
OUTPUT_DIR="${HOME}/Library/LaunchAgents"
WRITE_ONLY=0
RUNTIME_HOME="${TOPRANK_OPENCLAW_HOME:-$HOME/.toprank/openclaw}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      LABEL="$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --runtime-home)
      RUNTIME_HOME="$2"
      shift 2
      ;;
    --write-only)
      WRITE_ONLY=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$OUTPUT_DIR"
PLIST_PATH="$OUTPUT_DIR/${LABEL}.plist"
STDOUT_LOG="${RUNTIME_HOME}/logs/scheduler.stdout.log"
STDERR_LOG="${RUNTIME_HOME}/logs/scheduler.stderr.log"
mkdir -p "$(dirname "$STDOUT_LOG")"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${PYTHON_BIN}</string>
      <string>${REPO_ROOT}/openclaw/bin/run_scheduler.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>TOPRANK_OPENCLAW_HOME</key>
      <string>${RUNTIME_HOME}</string>
    </dict>
    <key>StartInterval</key>
    <integer>${INTERVAL}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>
  </dict>
</plist>
PLIST

plutil -lint "$PLIST_PATH" >/dev/null

echo "Wrote $PLIST_PATH"

if [[ "$WRITE_ONLY" == "1" ]]; then
  echo "Skipped launchctl load (--write-only)."
  exit 0
fi

launchctl bootout "gui/${UID}" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "$PLIST_PATH"
launchctl enable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true

echo "Loaded ${LABEL}"
