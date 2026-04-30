#!/usr/bin/env python3
"""Initialize a per-site work folder inside the Toprank OpenClaw runtime workspace."""

from __future__ import annotations

import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from runtime import bootstrap_workspace, ensure_site_dirs, load_json, save_json, workspace_root
from site_id import normalize_site_id


def bootstrap_site(site_input: str, root: Path | None = None) -> Path:
    site_id = normalize_site_id(site_input)
    root = bootstrap_workspace(root or workspace_root())
    site_root = ensure_site_dirs(site_id, root)

    profile = site_root / "site-profile.json"
    goals = site_root / "goals.json"
    latest = site_root / "latest-state.json"
    learned = site_root / "learned-patterns.json"

    if not profile.exists():
        save_json(
            profile,
            {
                "schema_version": "1",
                "site_id": site_id,
                "canonical_url": site_input if "://" in site_input else f"https://{site_id}",
                "display_name": site_id,
                "brand_terms": [],
                "cms": None,
                "business_context": None,
                "status": "active",
            },
        )

    if not goals.exists():
        save_json(goals, {"active": [], "archived": []})

    if not latest.exists():
        save_json(
            latest,
            {
                "site_id": site_id,
                "summary": "bootstrap complete",
                "open_issues": [],
                "recent_actions": [],
            },
        )

    if not learned.exists():
        save_json(learned, {"site_id": site_id, "observations": []})

    return site_root


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: bootstrap_site.py <url-or-domain>", file=sys.stderr)
        return 1
    print(bootstrap_site(argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
