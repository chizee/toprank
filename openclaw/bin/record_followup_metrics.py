#!/usr/bin/env python3
"""Attach observed metric values to a queued follow-up item and matching schedule entry."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from runtime import bootstrap_workspace, load_json, save_json, workspace_root


def parse_metric_pairs(values: list[str]) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for raw in values:
        if "=" not in raw:
            raise ValueError(f"metric must look like name=value, got: {raw}")
        name, value = raw.split("=", 1)
        metrics[name.strip()] = float(value)
    return metrics


def update_item(payload: dict, args: argparse.Namespace) -> dict:
    if args.primary_metric:
        payload["primary_metric"] = args.primary_metric
    if args.primary_direction:
        payload["primary_direction"] = args.primary_direction
    if args.success_threshold_pct is not None:
        payload["success_threshold_pct"] = args.success_threshold_pct
    if args.baseline_metric:
        payload["baseline_metrics"] = {**payload.get("baseline_metrics", {}), **parse_metric_pairs(args.baseline_metric)}
    if args.observed_metric:
        payload["observed_metrics"] = {**payload.get("observed_metrics", {}), **parse_metric_pairs(args.observed_metric)}
    if args.guardrail_metric:
        guardrails = payload.get("guardrail_metrics", [])
        for raw in args.guardrail_metric:
            metric, direction, max_worsen = raw.split(":", 2)
            guardrails.append({"metric": metric, "direction": direction, "max_worsen_pct": float(max_worsen)})
        payload["guardrail_metrics"] = guardrails
    if args.notes:
        payload["notes"] = args.notes
    return payload


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site_id")
    parser.add_argument("item_id")
    parser.add_argument("--primary-metric")
    parser.add_argument("--primary-direction", choices=["higher_better", "lower_better"])
    parser.add_argument("--success-threshold-pct", type=float)
    parser.add_argument("--baseline-metric", action="append", default=[])
    parser.add_argument("--observed-metric", action="append", default=[])
    parser.add_argument("--guardrail-metric", action="append", default=[], help="metric:direction:max_worsen_pct")
    parser.add_argument("--notes")
    args = parser.parse_args(argv[1:])

    root = bootstrap_workspace(workspace_root())
    queue_path = root / "sites" / args.site_id / "queue" / f"{args.item_id}.json"
    if not queue_path.exists():
        raise SystemExit(f"queue item not found: {queue_path}")

    queue_payload = load_json(queue_path, {})
    queue_payload = update_item(queue_payload, args)
    save_json(queue_path, queue_payload)

    schedule_path = root / "schedule.json"
    schedule = load_json(schedule_path, {"schema_version": "1", "upcoming": []})
    for item in schedule.get("upcoming", []):
        if item.get("item_id") == args.item_id and item.get("site_id") == args.site_id:
            item.update(queue_payload)
            break
    save_json(schedule_path, schedule)

    print(json.dumps({"queue_path": str(queue_path), "updated_item": queue_payload}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
