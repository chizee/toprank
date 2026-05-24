#!/usr/bin/env python3
"""Register or update a site in the NotFair OpenClaw portfolio."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from bootstrap_site import bootstrap_site
from runtime import load_json, now_iso, save_json, upsert_portfolio_site, workspace_root
from site_id import normalize_site_id


def parse_brand_terms(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def next_goal_id(active: list[dict], site_id: str) -> str:
    return f"goal_{site_id.replace('.', '_')}_{len(active) + 1:03d}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site")
    parser.add_argument("--display-name")
    parser.add_argument("--brand-terms", help="Comma-separated brand terms")
    parser.add_argument("--cms")
    parser.add_argument("--business-context")
    parser.add_argument("--business-weight", type=float, default=1.0)
    parser.add_argument("--cadence", default="weekly", choices=["daily", "weekly", "monthly", "on_demand"])
    parser.add_argument("--goal-type", default="grow_non_brand_clicks")
    parser.add_argument("--primary-metric", default="non_brand_clicks_28d")
    parser.add_argument("--target-delta", type=float)
    parser.add_argument("--skip-goal", action="store_true")
    args = parser.parse_args(argv[1:])

    root = workspace_root()
    site_id = normalize_site_id(args.site)
    site_path = bootstrap_site(args.site, root)

    profile_path = site_path / "site-profile.json"
    goals_path = site_path / "goals.json"
    latest_path = site_path / "latest-state.json"

    profile = load_json(profile_path, {})
    profile.update(
        {
            "schema_version": "1",
            "site_id": site_id,
            "canonical_url": args.site if "://" in args.site else f"https://{site_id}",
            "display_name": args.display_name or profile.get("display_name") or site_id,
            "brand_terms": parse_brand_terms(args.brand_terms) or profile.get("brand_terms") or [],
            "cms": args.cms if args.cms is not None else profile.get("cms"),
            "business_context": args.business_context if args.business_context is not None else profile.get("business_context"),
            "status": profile.get("status", "active"),
        }
    )
    save_json(profile_path, profile)

    portfolio_site = upsert_portfolio_site(
        site_id,
        display_name=profile["display_name"],
        business_weight=args.business_weight,
        cadence=args.cadence,
        status=profile["status"],
        root=root,
    )

    goals = load_json(goals_path, {"active": [], "archived": []})
    created_goal = None
    if not args.skip_goal:
        active = goals.setdefault("active", [])
        existing = next(
            (
                goal
                for goal in active
                if goal.get("type") == args.goal_type and goal.get("primary_metric") == args.primary_metric and goal.get("status") == "active"
            ),
            None,
        )
        if existing is None:
            created_goal = {
                "goal_id": next_goal_id(active, site_id),
                "site_id": site_id,
                "type": args.goal_type,
                "primary_metric": args.primary_metric,
                "target_delta": args.target_delta,
                "status": "active",
                "created_at": now_iso(),
            }
            active.append(created_goal)
            save_json(goals_path, goals)
        else:
            created_goal = existing

    latest = load_json(latest_path, {"site_id": site_id})
    latest.update(
        {
            "site_id": site_id,
            "generated_at": now_iso(),
            "summary": f"Onboarded {profile['display_name']} into the OpenClaw portfolio.",
            "open_issues": latest.get("open_issues", []),
            "recent_actions": [
                {
                    "type": "site_onboard",
                    "at": now_iso(),
                    "notes": f"Initialized work folder for {site_id}.",
                }
            ],
        }
    )
    save_json(latest_path, latest)

    result = {
        "site_id": site_id,
        "site_path": str(site_path),
        "portfolio_site": portfolio_site,
        "goal": created_goal,
    }
    print(__import__("json").dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
