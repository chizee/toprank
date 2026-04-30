#!/usr/bin/env python3
"""Persist OpenClaw run artifacts for a site review or follow-up."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from bootstrap_site import bootstrap_site
from runtime import ensure_site_dirs, load_json, now_iso, save_json, timestamp_slug, upsert_schedule_items, workspace_root
from site_id import normalize_site_id

ARTIFACT_KEYS = {
    "trigger": "trigger.json",
    "state_snapshot": "state-snapshot.json",
    "audit": "audit.json",
    "action_plan": "action-plan.json",
    "proposal": "proposal.json",
    "patch_set": "patch-set.json",
    "verification": "verification.json",
    "feedback": "feedback.json",
    "learning_log": "learning-log.json",
}


REQUIRED_KEYS = ["audit", "action_plan", "verification"]


def metric_direction(metric_name: str | None) -> str:
    if not metric_name:
        return "higher_better"
    return "lower_better" if "position" in metric_name.lower() else "higher_better"


def extract_metric_snapshot(payload: dict) -> dict:
    for source_key in ["state_snapshot", "audit", "proposal", "feedback"]:
        source = payload.get(source_key)
        if isinstance(source, dict) and isinstance(source.get("metrics"), dict):
            return dict(source["metrics"])
    return {}


def enrich_queue_items(payload: dict) -> None:
    queue_items = payload.get("queue_items")
    if not isinstance(queue_items, list):
        return
    metric_snapshot = extract_metric_snapshot(payload)
    first_action = None
    actions = payload.get("action_plan", {}).get("actions", []) if isinstance(payload.get("action_plan"), dict) else []
    if actions:
        first_action = actions[0]
    proposal = payload.get("proposal") if isinstance(payload.get("proposal"), dict) else {}
    trigger = payload.get("trigger") if isinstance(payload.get("trigger"), dict) else {}

    for item in queue_items:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "feedback_check":
            continue
        if first_action and not item.get("action_type"):
            item["action_type"] = first_action.get("type")
        if proposal.get("target") and not item.get("target"):
            item["target"] = proposal.get("target")
        elif trigger.get("target") and not item.get("target"):
            item["target"] = trigger.get("target")
        if metric_snapshot and not item.get("baseline_metrics"):
            item["baseline_metrics"] = dict(metric_snapshot)
        if not item.get("primary_metric") and metric_snapshot:
            preferred = [
                key
                for key in [
                    "non_brand_clicks_28d",
                    "organic_clicks_28d",
                    "organic_clicks_7d",
                    "organic_impressions_28d",
                    "organic_ctr_28d",
                    "avg_position_28d",
                ]
                if key in metric_snapshot
            ]
            item["primary_metric"] = preferred[0] if preferred else next(iter(metric_snapshot.keys()), None)
        if item.get("primary_metric") and not item.get("primary_direction"):
            item["primary_direction"] = metric_direction(item.get("primary_metric"))
        if "success_threshold_pct" not in item:
            item["success_threshold_pct"] = 0.1
        if "guardrail_metrics" not in item:
            item["guardrail_metrics"] = []


def with_defaults(payload: dict, site_id: str) -> dict:
    generated_at = payload.get("generated_at") or now_iso()
    payload["generated_at"] = generated_at
    for key in REQUIRED_KEYS:
        if key not in payload:
            raise ValueError(f"payload missing required key: {key}")
    enrich_queue_items(payload)
    for key in ["state_snapshot", "audit", "action_plan", "proposal", "patch_set", "verification", "feedback", "learning_log"]:
        if key in payload and isinstance(payload[key], dict):
            payload[key].setdefault("site_id", site_id)
            payload[key].setdefault("generated_at", generated_at)
    if "trigger" not in payload:
        payload["trigger"] = {"site_id": site_id, "generated_at": generated_at, "type": "manual_request"}
    else:
        payload["trigger"].setdefault("site_id", site_id)
        payload["trigger"].setdefault("generated_at", generated_at)
    return payload


def persist_queue_items(site_path: Path, queue_items: list[dict], site_id: str) -> tuple[list[str], list[dict]]:
    queue_dir = site_path / "queue"
    queue_dir.mkdir(parents=True, exist_ok=True)
    written = []
    normalized = []
    for index, item in enumerate(queue_items, start=1):
        item_id = item.get("item_id") or f"queue_{timestamp_slug()}_{index:02d}"
        item.setdefault("site_id", site_id)
        item.setdefault("status", "pending")
        item.setdefault("created_at", now_iso())
        item["item_id"] = item_id
        path = queue_dir / f"{item_id}.json"
        save_json(path, item)
        written.append(str(path))
        normalized.append(item)
    return written, normalized


def derive_latest_state(payload: dict, site_id: str) -> dict:
    if isinstance(payload.get("state_snapshot"), dict):
        latest = dict(payload["state_snapshot"])
        latest.setdefault("site_id", site_id)
        latest.setdefault("generated_at", payload["generated_at"])
        return latest

    audit = payload["audit"]
    actions = payload["action_plan"].get("actions", [])
    summary = audit.get("summary") or "Weekly review complete."
    open_issues = []
    for issue in audit.get("issues", [])[:5]:
        open_issues.append(
            {
                "title": issue.get("title"),
                "severity": issue.get("severity", "warning"),
                "confidence": issue.get("confidence"),
            }
        )
    recent_actions = []
    for action in actions[:3]:
        recent_actions.append(
            {
                "type": action.get("type"),
                "title": action.get("title"),
                "requires_approval": action.get("requires_approval", True),
            }
        )
    return {
        "site_id": site_id,
        "generated_at": payload["generated_at"],
        "summary": summary,
        "open_issues": open_issues,
        "recent_actions": recent_actions,
    }


def next_run_dir(site_path: Path) -> Path:
    base = timestamp_slug()
    candidate = site_path / "runs" / base
    if not candidate.exists():
        return candidate
    counter = 2
    while True:
        candidate = site_path / "runs" / f"{base}-{counter:02d}"
        if not candidate.exists():
            return candidate
        counter += 1


def persist_payload(site_input: str, payload: dict, *, root: Path | None = None) -> dict:
    root = root or workspace_root()
    site_id = normalize_site_id(site_input)
    site_path = ensure_site_dirs(site_id, root)
    if not (site_path / "site-profile.json").exists():
        bootstrap_site(site_input, root)

    payload = with_defaults(payload, site_id)

    run_dir = next_run_dir(site_path)
    run_dir.mkdir(parents=True, exist_ok=False)

    written = []
    for key, filename in ARTIFACT_KEYS.items():
        data = payload.get(key)
        if data is None:
            continue
        path = run_dir / filename
        save_json(path, data)
        written.append(str(path))

    latest_state = derive_latest_state(payload, site_id)
    save_json(site_path / "latest-state.json", latest_state)

    queue_paths = []
    schedule_items_written = []
    if isinstance(payload.get("queue_items"), list):
        queue_paths, normalized_queue = persist_queue_items(site_path, payload["queue_items"], site_id)
        schedule_candidates = [item for item in normalized_queue if item.get("due_at")]
        if schedule_candidates:
            schedule_items_written = upsert_schedule_items(schedule_candidates, root)

    return {
        "site_id": site_id,
        "run_dir": str(run_dir),
        "artifacts_written": written,
        "queue_items_written": queue_paths,
        "schedule_items_written": schedule_items_written,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site")
    parser.add_argument("--payload-file", required=True)
    args = parser.parse_args(argv[1:])

    payload = json.loads(Path(args.payload_file).read_text())
    result = persist_payload(args.site, payload)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
