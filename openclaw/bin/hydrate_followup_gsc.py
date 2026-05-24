#!/usr/bin/env python3
"""Fetch real GSC metrics for a follow-up item and attach them as observed metrics."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from runtime import bootstrap_workspace, load_json, workspace_root

ANALYZE_GSC = Path(__file__).resolve().parents[2] / "seo" / "seo-analysis" / "scripts" / "analyze_gsc.py"


def infer_days(primary_metric: str | None, fallback: int = 28) -> int:
    if not primary_metric:
        return fallback
    for part in primary_metric.split("_"):
        if part.endswith("d") and part[:-1].isdigit():
            return int(part[:-1])
    return fallback


def metric_suffix(days: int) -> str:
    return f"_{days}d"


def extract_metrics(data: dict, days: int) -> dict[str, float]:
    suffix = metric_suffix(days)
    summary = data.get("summary", {})
    metrics: dict[str, float] = {}
    if summary:
        metrics[f"organic_clicks{suffix}"] = float(summary.get("clicks", 0))
        metrics[f"organic_impressions{suffix}"] = float(summary.get("impressions", 0))
        metrics[f"organic_ctr{suffix}"] = float(summary.get("ctr", 0))
        metrics[f"avg_position{suffix}"] = float(summary.get("position", 0))
    branded_split = data.get("branded_split") or {}
    branded = branded_split.get("branded") or {}
    non_branded = branded_split.get("non_branded") or {}
    if branded or non_branded:
        metrics[f"branded_clicks{suffix}"] = float(branded.get("clicks", 0))
        metrics[f"non_brand_clicks{suffix}"] = float(non_branded.get("clicks", 0))
        metrics[f"branded_impressions{suffix}"] = float(branded.get("impressions", 0))
        metrics[f"non_brand_impressions{suffix}"] = float(non_branded.get("impressions", 0))
    return metrics


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site_id")
    parser.add_argument("item_id")
    parser.add_argument("--gsc-property")
    parser.add_argument("--brand-terms")
    parser.add_argument("--days", type=int)
    parser.add_argument("--analysis-file")
    args = parser.parse_args(argv[1:])

    root = bootstrap_workspace(workspace_root())
    site_root = root / "sites" / args.site_id
    queue_path = site_root / "queue" / f"{args.item_id}.json"
    if not queue_path.exists():
        raise SystemExit(f"queue item not found: {queue_path}")
    queue_item = load_json(queue_path, {})
    profile = load_json(site_root / "site-profile.json", {})

    primary_metric = queue_item.get("primary_metric")
    days = args.days or infer_days(primary_metric, 28)
    gsc_property = args.gsc_property or profile.get("gsc_property") or profile.get("canonical_url")
    if not gsc_property:
        raise SystemExit("No GSC property or canonical_url available for this site.")

    brand_terms = args.brand_terms or ",".join(profile.get("brand_terms", []))

    if args.analysis_file:
        data = json.loads(Path(args.analysis_file).read_text())
    else:
        with tempfile.NamedTemporaryFile(prefix="notfair_gsc_", suffix=".json", delete=False) as tmp:
            output_path = Path(tmp.name)

        cmd = [sys.executable, str(ANALYZE_GSC), "--site", gsc_property, "--days", str(days), "--output", str(output_path)]
        if brand_terms:
            cmd.extend(["--brand-terms", brand_terms])
        subprocess.run(cmd, check=True)

        data = json.loads(output_path.read_text())
    observed_metrics = extract_metrics(data, days)
    queue_item.setdefault("observed_metrics", {})
    queue_item["observed_metrics"].update(observed_metrics)
    queue_path.write_text(json.dumps(queue_item, indent=2, ensure_ascii=False) + "\n")

    schedule_path = root / "schedule.json"
    schedule = load_json(schedule_path, {"schema_version": "1", "upcoming": []})
    for item in schedule.get("upcoming", []):
        if item.get("item_id") == args.item_id and item.get("site_id") == args.site_id:
            item.setdefault("observed_metrics", {})
            item["observed_metrics"].update(observed_metrics)
            break
    schedule_path.write_text(json.dumps(schedule, indent=2, ensure_ascii=False) + "\n")

    print(json.dumps({
        "queue_path": str(queue_path),
        "gsc_property": gsc_property,
        "days": days,
        "observed_metrics": observed_metrics,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
