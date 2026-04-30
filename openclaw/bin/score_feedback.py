#!/usr/bin/env python3
"""Score a follow-up outcome from before/after metrics."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

DIRECTION_HIGHER = "higher_better"
DIRECTION_LOWER = "lower_better"
VALID_DIRECTIONS = {DIRECTION_HIGHER, DIRECTION_LOWER}


def normalized_change(before: float, after: float, direction: str) -> float:
    if before == 0:
        if after == 0:
            return 0.0
        raw = 1.0
    else:
        raw = (after - before) / abs(before)
    if direction == DIRECTION_LOWER:
        return -raw
    return raw


def score_item(item: dict[str, Any]) -> dict[str, Any]:
    baseline = item.get("baseline_metrics") or {}
    observed = item.get("observed_metrics") or {}
    primary_metric = item.get("primary_metric")
    primary_direction = item.get("primary_direction", DIRECTION_HIGHER)
    threshold = float(item.get("success_threshold_pct", 0.1))
    guardrails = item.get("guardrail_metrics") or []

    if primary_direction not in VALID_DIRECTIONS:
        raise ValueError(f"invalid primary_direction: {primary_direction}")
    if not primary_metric:
        return {"outcome": "inconclusive", "reason": "missing primary_metric"}
    if primary_metric not in baseline or primary_metric not in observed:
        return {"outcome": "inconclusive", "reason": f"missing metric data for {primary_metric}"}

    before = float(baseline[primary_metric])
    after = float(observed[primary_metric])
    primary_change = normalized_change(before, after, primary_direction)

    metric_deltas: dict[str, dict[str, float | str]] = {}
    for metric in set(baseline) & set(observed):
        direction = DIRECTION_HIGHER
        if metric == primary_metric:
            direction = primary_direction
        for guardrail in guardrails:
            if guardrail.get("metric") == metric:
                direction = guardrail.get("direction", direction)
                break
        metric_deltas[metric] = {
            "before": float(baseline[metric]),
            "after": float(observed[metric]),
            "normalized_change": round(normalized_change(float(baseline[metric]), float(observed[metric]), direction), 4),
            "direction": direction,
        }

    guardrail_failures = []
    for guardrail in guardrails:
        metric = guardrail.get("metric")
        if metric not in baseline or metric not in observed:
            continue
        direction = guardrail.get("direction", DIRECTION_HIGHER)
        max_worsen_pct = float(guardrail.get("max_worsen_pct", 0.05))
        delta = normalized_change(float(baseline[metric]), float(observed[metric]), direction)
        if delta < -max_worsen_pct:
            guardrail_failures.append(
                {
                    "metric": metric,
                    "normalized_change": round(delta, 4),
                    "max_worsen_pct": max_worsen_pct,
                }
            )

    if guardrail_failures:
        outcome = "loss"
        reason = "guardrail failure"
    elif primary_change >= threshold:
        outcome = "win"
        reason = "primary metric improved"
    elif primary_change <= -threshold:
        outcome = "loss"
        reason = "primary metric worsened"
    else:
        outcome = "neutral"
        reason = "change stayed within the neutral band"

    confidence = min(0.95, round(0.55 + min(abs(primary_change), 1.0) * 0.35 + min(len(guardrails), 2) * 0.03, 2))

    return {
        "outcome": outcome,
        "reason": reason,
        "primary_metric": primary_metric,
        "primary_direction": primary_direction,
        "primary_change": round(primary_change, 4),
        "success_threshold_pct": threshold,
        "guardrail_failures": guardrail_failures,
        "metric_deltas": metric_deltas,
        "confidence": confidence,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--item-file", required=True)
    args = parser.parse_args(argv[1:])
    item = json.loads(Path(args.item_file).read_text())
    print(json.dumps(score_item(item), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
