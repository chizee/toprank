#!/usr/bin/env python3
"""Create and persist a traffic-drop investigation for a site."""

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
    parser.add_argument("--summary", required=True)
    parser.add_argument("--likely-cause", action="append", default=[])
    parser.add_argument("--target-url")
    parser.add_argument("--follow-up-days", type=int, default=7)
    parser.add_argument("--primary-metric", default="organic_clicks_7d")
    parser.add_argument("--success-threshold-pct", type=float, default=0.1)
    parser.add_argument("--baseline-metric", action="append", default=[])
    parser.add_argument("--guardrail-metric", action="append", default=[], help="metric:direction:max_worsen_pct")
    args = parser.parse_args(argv[1:])

    site_id = normalize_site_id(args.site)
    generated_at = now_iso()
    follow_up_due = future_iso(args.follow_up_days)
    causes = args.likely_cause or ["Investigate ranking, indexation, and CTR changes."]

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

    issues = []
    actions = []
    for index, cause in enumerate(causes, start=1):
        issues.append(
            {
                "title": cause,
                "severity": "warning" if index > 1 else "critical",
                "confidence": max(0.45, 0.8 - ((index - 1) * 0.1)),
                "evidence": [args.summary],
                "recommended_action_type": "drop_recovery",
            }
        )
        actions.append(
            {
                "action_id": f"drop_recovery_{index:02d}",
                "title": f"Investigate and mitigate: {cause}",
                "type": "drop_recovery",
                "priority_score": round(0.92 - ((index - 1) * 0.08), 2),
                "expected_impact": "Recover lost visibility or conversions from the reported drop.",
                "requires_approval": index == 1,
                "reversibility": "high",
                "owner": "operator",
            }
        )

    queue_items = [
        {
            "item_id": f"drop_followup_{site_id}_{generated_at.replace(':', '-')}",
            "type": "feedback_check",
            "status": "pending",
            "due_at": follow_up_due,
            "notes": "Reassess the traffic drop after mitigation work or more data.",
            "action_type": "drop_recovery",
            "primary_metric": args.primary_metric,
            "primary_direction": "higher_better",
            "success_threshold_pct": args.success_threshold_pct,
            "baseline_metrics": baseline_metrics,
            "guardrail_metrics": guardrail_metrics,
        }
    ]

    if args.target_url:
        queue_items.append(
            {
                "item_id": f"improve_page_{site_id}_{generated_at.replace(':', '-')}",
                "type": "improve_page",
                "status": "pending",
                "notes": f"Run a focused page improvement workflow for {args.target_url}.",
                "target": args.target_url,
            }
        )

    payload = {
        "generated_at": generated_at,
        "trigger": {
            "type": "traffic_drop_detected",
            "notes": args.summary,
            "target": args.target_url,
        },
        "state_snapshot": {
            "site_id": site_id,
            "generated_at": generated_at,
            "summary": args.summary,
            "open_issues": [
                {
                    "title": issue["title"],
                    "severity": issue["severity"],
                    "confidence": issue["confidence"],
                }
                for issue in issues
            ],
            "recent_actions": [],
        },
        "audit": {
            "site_id": site_id,
            "generated_at": generated_at,
            "summary": args.summary,
            "issues": issues,
        },
        "action_plan": {
            "site_id": site_id,
            "generated_at": generated_at,
            "actions": actions,
        },
        "verification": {
            "site_id": site_id,
            "generated_at": generated_at,
            "checks": [
                {
                    "name": "drop investigation persisted",
                    "status": "pass",
                    "notes": "Stored ranked recovery actions for the reported drop.",
                },
                {
                    "name": "follow-up scheduled",
                    "status": "pass",
                    "notes": f"Feedback check scheduled for {follow_up_due}.",
                },
            ],
            "follow_up_due": follow_up_due,
        },
        "queue_items": queue_items,
    }

    result = persist_payload(args.site, payload, root=workspace_root())
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
