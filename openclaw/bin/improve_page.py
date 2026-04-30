#!/usr/bin/env python3
"""Create and persist a page-improvement proposal for a site."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from persist_run import persist_payload
from runtime import now_iso, workspace_root
from site_id import normalize_site_id


def future_iso(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site")
    parser.add_argument("--url", required=True)
    parser.add_argument("--issue-summary", required=True)
    parser.add_argument("--proposal-summary", required=True)
    parser.add_argument("--action-type", default="page_improvement")
    parser.add_argument("--expected-impact", default="Improve organic performance for the target page.")
    parser.add_argument("--requires-approval", dest="requires_approval", action="store_true", default=True)
    parser.add_argument("--auto-safe", dest="requires_approval", action="store_false")
    parser.add_argument("--follow-up-days", type=int, default=14)
    parser.add_argument("--primary-metric", default="organic_clicks_28d")
    parser.add_argument("--success-threshold-pct", type=float, default=0.1)
    parser.add_argument("--baseline-metric", action="append", default=[])
    parser.add_argument("--guardrail-metric", action="append", default=[], help="metric:direction:max_worsen_pct")
    parser.add_argument("--patch-path", action="append", default=[])
    parser.add_argument("--patch-summary", action="append", default=[])
    args = parser.parse_args(argv[1:])

    site_id = normalize_site_id(args.site)
    generated_at = now_iso()
    follow_up_due = future_iso(args.follow_up_days)

    baseline_metrics = {}
    for raw in args.baseline_metric:
        if "=" not in raw:
            raise SystemExit(f"baseline metric must look like name=value, got: {raw}")
        name, value = raw.split("=", 1)
        baseline_metrics[name.strip()] = float(value)

    guardrail_metrics = []
    for raw in args.guardrail_metric:
        metric, direction, max_worsen = raw.split(":", 2)
        guardrail_metrics.append({"metric": metric, "direction": direction, "max_worsen_pct": float(max_worsen)})

    proposal = {
        "site_id": site_id,
        "generated_at": generated_at,
        "proposal_type": args.action_type,
        "target": args.url,
        "summary": args.proposal_summary,
        "requires_approval": args.requires_approval,
    }

    payload: dict = {
        "generated_at": generated_at,
        "trigger": {
            "type": "improve_page",
            "target": args.url,
            "notes": f"Improve page workflow for {args.url}.",
        },
        "state_snapshot": {
            "site_id": site_id,
            "generated_at": generated_at,
            "summary": f"Page improvement requested for {args.url}.",
            "open_issues": [
                {
                    "title": args.issue_summary,
                    "severity": "warning",
                    "confidence": 0.75,
                }
            ],
            "recent_actions": [],
        },
        "audit": {
            "site_id": site_id,
            "generated_at": generated_at,
            "summary": f"Focused page review for {args.url}.",
            "issues": [
                {
                    "title": args.issue_summary,
                    "severity": "warning",
                    "confidence": 0.75,
                    "evidence": [f"Target URL: {args.url}"],
                    "recommended_action_type": args.action_type,
                }
            ],
        },
        "action_plan": {
            "site_id": site_id,
            "generated_at": generated_at,
            "actions": [
                {
                    "action_id": f"improve_page_{site_id}_{generated_at.replace(':', '-')}",
                    "title": args.proposal_summary,
                    "type": args.action_type,
                    "priority_score": 0.82,
                    "expected_impact": args.expected_impact,
                    "requires_approval": args.requires_approval,
                    "reversibility": "high",
                    "owner": "operator",
                }
            ],
        },
        "proposal": proposal,
        "verification": {
            "site_id": site_id,
            "generated_at": generated_at,
            "checks": [
                {
                    "name": "proposal persisted",
                    "status": "pass",
                    "notes": f"Stored proposal artifact for {args.url}.",
                },
                {
                    "name": "approval gate",
                    "status": "warning" if args.requires_approval else "pass",
                    "notes": "External or production writes still require approval." if args.requires_approval else "No external write requested yet.",
                },
            ],
            "follow_up_due": follow_up_due,
        },
        "queue_items": [
            {
                "item_id": f"followup_{site_id}_{generated_at.replace(':', '-')}",
                "type": "feedback_check",
                "status": "pending",
                "due_at": follow_up_due,
                "notes": f"Review impact of page improvement for {args.url}.",
                "action_type": args.action_type,
                "primary_metric": args.primary_metric,
                "primary_direction": "higher_better",
                "success_threshold_pct": args.success_threshold_pct,
                "baseline_metrics": baseline_metrics,
                "guardrail_metrics": guardrail_metrics,
            }
        ],
    }

    if args.patch_path:
        patches = []
        for index, path in enumerate(args.patch_path):
            summary = args.patch_summary[index] if index < len(args.patch_summary) else f"Patch proposal for {path}"
            patches.append({"path": path, "change_type": args.action_type, "summary": summary})
        payload["patch_set"] = {
            "site_id": site_id,
            "generated_at": generated_at,
            "patches": patches,
        }

    result = persist_payload(args.site, payload, root=workspace_root())
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
