#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL_TARGET_DIR="${OPENCLAW_SKILLS_DIR:-$HOME/.openclaw/skills}"

mkdir -p "$SKILL_TARGET_DIR"
python3 "$REPO_ROOT/openclaw/bin/bootstrap_workspace.py" >/dev/null

for skill_dir in "$REPO_ROOT"/openclaw/skills/*; do
  name="$(basename "$skill_dir")"
  ln -sfn "$skill_dir" "$SKILL_TARGET_DIR/$name"
  echo "linked $name -> $skill_dir"
done

echo
echo "OpenClaw skills installed."
echo "Runtime home: ${TOPRANK_OPENCLAW_HOME:-$HOME/.toprank/openclaw}"
echo "Skills dir: $SKILL_TARGET_DIR"
