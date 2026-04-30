#!/usr/bin/env python3
"""List due or upcoming follow-up items from the Toprank OpenClaw schedule."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from runtime import bootstrap_workspace, load_json, now_iso, workspace_root


def parse_iso(value: str | None) -> datetime:
    if not value:
        return datetime.max.replace(tzinfo=timezone.utc)
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site")
    parser.add_argument("--include-future", action="store_true")
    parser.add_argument("--as-of", default=now_iso())
    args = parser.parse_args(argv[1:])

    root = bootstrap_workspace(workspace_root())
    schedule = load_json(root / "schedule.json", {"upcoming": []})
    cutoff = parse_iso(args.as_of)

    items = []
    for item in schedule.get("upcoming", []):
        if args.site and item.get("site_id") != args.site:
            continue
        due_at = parse_iso(item.get("due_at"))
        if args.include_future or due_at <= cutoff:
            items.append(item)

    items.sort(key=lambda item: item.get("due_at") or "")
    result = {
        "generated_at": now_iso(),
        "as_of": args.as_of,
        "site_filter": args.site,
        "count": len(items),
        "items": items,
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
