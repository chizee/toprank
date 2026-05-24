#!/usr/bin/env python3
"""Rank active sites in the NotFair OpenClaw portfolio by urgency and upside."""

from __future__ import annotations

import json
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from runtime import bootstrap_workspace, load_json, now_iso, save_json, timestamp_slug, workspace_root

SEVERITY_WEIGHTS = {
    "critical": 3.0,
    "warning": 1.5,
    "info": 0.5,
}


def site_priority(record: dict, latest_state: dict, goals: dict) -> tuple[float, dict]:
    open_issues = latest_state.get("open_issues", [])
    urgency = sum(SEVERITY_WEIGHTS.get(issue.get("severity", "warning"), 1.0) for issue in open_issues) or 0.5
    active_goals = len(goals.get("active", [])) or 1
    business_weight = float(record.get("business_weight", 1.0))
    opportunity = 1.0 + (0.25 * min(active_goals, 4))
    score = round(business_weight * urgency * opportunity, 3)
    summary = latest_state.get("summary") or "No recent state summary."
    return score, {
        "site_id": record["site_id"],
        "display_name": record.get("display_name") or record["site_id"],
        "score": score,
        "business_weight": business_weight,
        "open_issue_count": len(open_issues),
        "active_goal_count": len(goals.get("active", [])),
        "summary": summary,
        "top_issue": open_issues[0]["title"] if open_issues else None,
    }


def main(argv: list[str]) -> int:
    root = bootstrap_workspace(workspace_root())
    portfolio = load_json(root / "portfolio.json", {"sites": []})
    active_sites = [site for site in portfolio.get("sites", []) if site.get("status", "active") == "active"]

    rankings = []
    for record in active_sites:
        site_root = root / "sites" / record["site_id"]
        latest_state = load_json(site_root / "latest-state.json", {"summary": "No state yet.", "open_issues": []})
        goals = load_json(site_root / "goals.json", {"active": [], "archived": []})
        score, site_summary = site_priority(record, latest_state, goals)
        rankings.append(site_summary)

    rankings.sort(key=lambda item: item["score"], reverse=True)
    result = {
        "generated_at": now_iso(),
        "site_count": len(rankings),
        "rankings": rankings,
        "recommended_focus_site": rankings[0]["site_id"] if rankings else None,
    }

    output_dir = root / "portfolio-reviews"
    output_dir.mkdir(parents=True, exist_ok=True)
    save_json(output_dir / f"{timestamp_slug()}.json", result)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
