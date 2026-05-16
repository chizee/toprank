#!/usr/bin/env python3
"""publish_pending.py — publish ready blog posts from a NotFair content calendar.

Reads content-calendar.json, finds entries marked status: "ready_to_publish"
that have a `bodyPath` pointing at a written file, POSTs each to the configured
NotFair Next.js webhook, and updates the entry to status: "published" or
"failed" based on the response.

Designed to run as an OpenClaw cron job. Safe by default:

- Dry-run unless --commit is passed (or OPENCLAW_PUBLISH_COMMIT=1)
- Stops cleanly when the calendar is missing or has nothing ready
- 2xx          → entry becomes status: "published", publishedAt + response stored
- 4xx          → entry becomes status: "failed", lastError stored (non-retryable)
- 5xx          → entry stays "ready_to_publish", lastError stored, exit non-zero
- Network err  → entry stays "ready_to_publish", lastError stored, exit non-zero

Environment:
  NOTFAIR_PUBLISH_URL       webhook URL (default: https://notfair.co/api/blog/publish)
  NOTFAIR_PUBLISH_TOKEN     Bearer token; required in --commit mode
  OPENCLAW_PUBLISH_COMMIT   "1" → write mode without passing --commit
  OPENCLAW_PUBLISH_CALENDAR explicit calendar path

Webhook contract: see openclaw/install/notfair-publisher.md.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_WEBHOOK = "https://notfair.co/api/blog/publish"
DEFAULT_TIMEOUT_SECS = 30
READY_STATUS = "ready_to_publish"
PUBLISHED_STATUS = "published"
FAILED_STATUS = "failed"


def now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def resolve_calendar_path(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("OPENCLAW_PUBLISH_CALENDAR")
    if env:
        return Path(env).expanduser().resolve()
    project = Path.cwd() / ".notfair" / "content-calendar.json"
    if project.is_file():
        return project
    return Path.home() / ".notfair" / "content-calendar.json"


def load_calendar(path: Path) -> dict | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_calendar(path: Path, calendar: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(calendar, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def read_body(body_path: str, calendar_dir: Path) -> str:
    p = Path(body_path).expanduser()
    if not p.is_absolute():
        p = (calendar_dir / p).resolve()
    return p.read_text(encoding="utf-8")


def build_payload(entry: dict, body: str) -> dict[str, Any]:
    """Map a calendar entry to the webhook payload.

    The Next.js endpoint contract is documented in
    openclaw/install/notfair-publisher.md — keep them in sync.
    """
    return {
        "schemaVersion": "1",
        "slug": entry.get("id"),
        "title": entry.get("title"),
        "primaryKeyword": entry.get("primaryKeyword"),
        "secondaryKeywords": entry.get("secondaryKeywords") or [],
        "intent": entry.get("intent"),
        "type": entry.get("type", "blog"),
        "metaDescription": entry.get("metaDescription"),
        "body": body,
        "bodyFormat": entry.get("bodyFormat", "markdown"),
        "featuredImage": entry.get("featuredImage"),
        "inlineImages": entry.get("inlineImages") or [],
        "structuredData": entry.get("structuredData"),
        "scheduledAt": entry.get("scheduledDate"),
        "source": {"tool": "toprank", "skill": "content-planner", "version": "1"},
    }


def post_to_webhook(
    url: str, token: str, payload: dict, timeout: int = DEFAULT_TIMEOUT_SECS
) -> tuple[int, dict | str]:
    """POST payload to the webhook. Returns (status_code, parsed_body_or_text)."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "toprank-publisher/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, _try_parse(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else str(exc)
        return exc.code, _try_parse(raw)


def _try_parse(raw: str) -> dict | str:
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return raw


def ready_entries(calendar: dict, site_filter: str | None) -> list[dict]:
    out = []
    for entry in calendar.get("topics") or []:
        if entry.get("status") != READY_STATUS:
            continue
        if not entry.get("bodyPath"):
            continue
        if site_filter and entry.get("site") != site_filter:
            continue
        out.append(entry)
    return out


def publish_one(
    entry: dict,
    *,
    webhook: str,
    token: str,
    calendar_dir: Path,
    dry_run: bool,
) -> dict:
    body_path = entry["bodyPath"]
    try:
        body = read_body(body_path, calendar_dir)
    except OSError as exc:
        entry["status"] = FAILED_STATUS
        entry["lastError"] = f"could not read bodyPath '{body_path}': {exc}"
        entry["lastAttemptAt"] = now_iso()
        return {"id": entry.get("id"), "outcome": "skipped", "reason": "body unreadable"}

    payload = build_payload(entry, body)

    if dry_run:
        return {
            "id": entry.get("id"),
            "outcome": "dry-run",
            "would_post_to": webhook,
            "payload_bytes": len(json.dumps(payload)),
        }

    try:
        status, body_resp = post_to_webhook(webhook, token, payload)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        entry["lastError"] = f"network: {exc}"
        entry["lastAttemptAt"] = now_iso()
        return {"id": entry.get("id"), "outcome": "network-error", "error": str(exc)}

    entry["lastAttemptAt"] = now_iso()

    if 200 <= status < 300:
        entry["status"] = PUBLISHED_STATUS
        entry["publishedAt"] = now_iso()
        if isinstance(body_resp, dict):
            url = body_resp.get("url") or body_resp.get("publishedUrl")
            if url:
                entry["publishedUrl"] = url
            entry["response"] = body_resp
        entry.pop("lastError", None)
        return {"id": entry.get("id"), "outcome": "published", "status": status}

    if 400 <= status < 500:
        entry["status"] = FAILED_STATUS
        entry["lastError"] = f"HTTP {status}: {body_resp}"
        return {"id": entry.get("id"), "outcome": "failed", "status": status}

    entry["lastError"] = f"HTTP {status}: {body_resp}"
    return {"id": entry.get("id"), "outcome": "retry", "status": status}


def run(
    *,
    calendar_path: Path,
    webhook: str,
    token: str | None,
    dry_run: bool,
    site_filter: str | None,
) -> dict:
    calendar = load_calendar(calendar_path)
    if calendar is None:
        return {"ok": True, "processed": [], "note": f"no calendar at {calendar_path}"}

    candidates = ready_entries(calendar, site_filter)
    if not candidates:
        return {"ok": True, "processed": [], "note": "no entries ready_to_publish"}

    if not token and not dry_run:
        return {
            "ok": False,
            "processed": [],
            "error": "NOTFAIR_PUBLISH_TOKEN is unset; refusing to publish. Set the env var or pass --dry-run.",
        }

    processed = []
    any_retry_or_network = False

    for entry in candidates:
        result = publish_one(
            entry,
            webhook=webhook,
            token=token or "",
            calendar_dir=calendar_path.parent,
            dry_run=dry_run,
        )
        processed.append(result)
        if result["outcome"] in ("retry", "network-error"):
            any_retry_or_network = True

    if not dry_run:
        save_calendar(calendar_path, calendar)

    return {
        "ok": not any_retry_or_network,
        "processed": processed,
        "calendar": str(calendar_path),
        "dryRun": dry_run,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="publish_pending")
    p.add_argument("--calendar", default=None,
                   help="Path to content-calendar.json (default: ./.notfair/... → ~/.notfair/...)")
    p.add_argument("--site", default=None,
                   help="Only publish entries matching this site id")
    p.add_argument("--webhook", default=None,
                   help=f"Webhook URL (default: $NOTFAIR_PUBLISH_URL or {DEFAULT_WEBHOOK})")
    p.add_argument("--commit", action="store_true",
                   help="Actually POST. Default is dry-run.")
    p.add_argument("--dry-run", action="store_true",
                   help="Force dry-run even if OPENCLAW_PUBLISH_COMMIT=1.")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    commit_env = os.environ.get("OPENCLAW_PUBLISH_COMMIT") == "1"
    dry_run = args.dry_run or not (args.commit or commit_env)

    calendar_path = resolve_calendar_path(args.calendar)
    webhook = args.webhook or os.environ.get("NOTFAIR_PUBLISH_URL") or DEFAULT_WEBHOOK
    token = os.environ.get("NOTFAIR_PUBLISH_TOKEN")

    result = run(
        calendar_path=calendar_path,
        webhook=webhook,
        token=token,
        dry_run=dry_run,
        site_filter=args.site,
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
