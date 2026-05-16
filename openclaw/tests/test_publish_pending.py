"""Tests for openclaw/bin/publish_pending.py."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

BIN_DIR = Path(__file__).resolve().parents[1] / "bin"
if str(BIN_DIR) not in sys.path:
    sys.path.insert(0, str(BIN_DIR))

import publish_pending as pp


def _calendar_with(entries):
    return {
        "schema_version": "1",
        "generated": "2026-05-15T00:00:00Z",
        "site": "https://example.com",
        "topics": entries,
        "warnings": [],
    }


def _ready_entry(idx=1, body="# Hello\n\nBody.", with_body_path=True, **overrides):
    """Return (entry, body_path) — body_path is None if with_body_path is False."""
    return {
        "id": f"post-{idx}",
        "title": "Hook-Driven Title",
        "primaryKeyword": "test keyword",
        "secondaryKeywords": ["k1", "k2"],
        "intent": "informational",
        "type": "blog",
        "metaDescription": "meta",
        "scheduledDate": "2026-05-22",
        "status": "ready_to_publish",
        "priority": "P0",
        "bodyPath": f"bodies/post-{idx}.md" if with_body_path else None,
        **overrides,
    }


class PublishPendingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calendar_path = self.root / "content-calendar.json"
        (self.root / "bodies").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _write_calendar(self, entries):
        pp.save_calendar(self.calendar_path, _calendar_with(entries))

    def _write_body(self, idx, body="# Hello\n\nBody."):
        (self.root / "bodies" / f"post-{idx}.md").write_text(body)

    # ── Calendar resolution / empty cases ───────────────────────────────

    def test_missing_calendar_returns_ok_no_processing(self):
        result = pp.run(
            calendar_path=self.root / "nope.json",
            webhook="https://x",
            token="t",
            dry_run=False,
            site_filter=None,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["processed"], [])
        self.assertIn("no calendar at", result["note"])

    def test_calendar_with_no_ready_entries_is_a_noop(self):
        self._write_calendar([
            {"id": "planned-1", "status": "planned", "bodyPath": "bodies/planned-1.md"},
            {"id": "published-1", "status": "published", "bodyPath": "bodies/x.md"},
        ])
        result = pp.run(
            calendar_path=self.calendar_path, webhook="https://x", token="t",
            dry_run=False, site_filter=None,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["processed"], [])
        self.assertEqual(result["note"], "no entries ready_to_publish")

    def test_ready_entry_without_body_path_is_skipped(self):
        self._write_calendar([_ready_entry(1, with_body_path=False)])
        result = pp.run(
            calendar_path=self.calendar_path, webhook="https://x", token="t",
            dry_run=False, site_filter=None,
        )
        self.assertEqual(result["processed"], [])

    # ── Safety / commit gating ──────────────────────────────────────────

    def test_commit_mode_without_token_refuses(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        result = pp.run(
            calendar_path=self.calendar_path, webhook="https://x", token=None,
            dry_run=False, site_filter=None,
        )
        self.assertFalse(result["ok"])
        self.assertIn("NOTFAIR_PUBLISH_TOKEN", result["error"])

        cal = pp.load_calendar(self.calendar_path)
        self.assertEqual(cal["topics"][0]["status"], "ready_to_publish")

    def test_dry_run_does_not_post_and_does_not_mutate(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        with mock.patch.object(pp, "post_to_webhook") as mocked:
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token=None,
                dry_run=True, site_filter=None,
            )
        mocked.assert_not_called()
        self.assertTrue(result["ok"])
        self.assertEqual(result["processed"][0]["outcome"], "dry-run")

        cal = pp.load_calendar(self.calendar_path)
        self.assertEqual(cal["topics"][0]["status"], "ready_to_publish")
        self.assertNotIn("publishedAt", cal["topics"][0])

    # ── Success path ───────────────────────────────────────────────────

    def test_2xx_marks_published_and_stores_url(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        with mock.patch.object(
            pp, "post_to_webhook",
            return_value=(201, {"ok": True, "url": "https://notfair.co/blog/post-1"}),
        ):
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token="t",
                dry_run=False, site_filter=None,
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["processed"][0]["outcome"], "published")

        cal = pp.load_calendar(self.calendar_path)
        entry = cal["topics"][0]
        self.assertEqual(entry["status"], "published")
        self.assertEqual(entry["publishedUrl"], "https://notfair.co/blog/post-1")
        self.assertIn("publishedAt", entry)
        self.assertEqual(entry["response"]["ok"], True)

    # ── 4xx / failed ───────────────────────────────────────────────────

    def test_400_marks_failed_and_records_error(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        with mock.patch.object(
            pp, "post_to_webhook",
            return_value=(400, {"ok": False, "error": "invalid slug"}),
        ):
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token="t",
                dry_run=False, site_filter=None,
            )
        # 4xx is non-retryable but not a "system" failure for the publisher,
        # so the run is still ok (the entry is marked failed for the user).
        self.assertTrue(result["ok"])
        self.assertEqual(result["processed"][0]["outcome"], "failed")
        self.assertEqual(result["processed"][0]["status"], 400)

        cal = pp.load_calendar(self.calendar_path)
        entry = cal["topics"][0]
        self.assertEqual(entry["status"], "failed")
        self.assertIn("HTTP 400", entry["lastError"])

    # ── 5xx / retry ────────────────────────────────────────────────────

    def test_5xx_leaves_entry_ready_and_exits_non_ok(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        with mock.patch.object(
            pp, "post_to_webhook",
            return_value=(503, "service unavailable"),
        ):
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token="t",
                dry_run=False, site_filter=None,
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["processed"][0]["outcome"], "retry")

        cal = pp.load_calendar(self.calendar_path)
        entry = cal["topics"][0]
        self.assertEqual(entry["status"], "ready_to_publish")
        self.assertIn("HTTP 503", entry["lastError"])

    # ── Network error ──────────────────────────────────────────────────

    def test_network_error_leaves_entry_ready_and_exits_non_ok(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        with mock.patch.object(
            pp, "post_to_webhook",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token="t",
                dry_run=False, site_filter=None,
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["processed"][0]["outcome"], "network-error")

        cal = pp.load_calendar(self.calendar_path)
        entry = cal["topics"][0]
        self.assertEqual(entry["status"], "ready_to_publish")
        self.assertIn("network:", entry["lastError"])

    # ── Body unreadable ────────────────────────────────────────────────

    def test_missing_body_file_marks_failed(self):
        # Calendar references body but file isn't created
        self._write_calendar([_ready_entry(1)])
        # No _write_body call
        with mock.patch.object(pp, "post_to_webhook") as mocked:
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token="t",
                dry_run=False, site_filter=None,
            )
        mocked.assert_not_called()
        self.assertEqual(result["processed"][0]["outcome"], "skipped")

        cal = pp.load_calendar(self.calendar_path)
        entry = cal["topics"][0]
        self.assertEqual(entry["status"], "failed")
        self.assertIn("could not read bodyPath", entry["lastError"])

    # ── Multiple entries ───────────────────────────────────────────────

    def test_multiple_entries_processed_independently(self):
        self._write_calendar([
            _ready_entry(1),
            _ready_entry(2),
            {"id": "planned", "status": "planned", "bodyPath": "bodies/x.md"},  # not ready
        ])
        self._write_body(1)
        self._write_body(2)

        def fake_post(url, token, payload, timeout=30):
            if payload["slug"] == "post-1":
                return 201, {"ok": True, "url": "https://notfair.co/blog/post-1"}
            return 400, {"error": "nope"}

        with mock.patch.object(pp, "post_to_webhook", side_effect=fake_post):
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token="t",
                dry_run=False, site_filter=None,
            )

        outcomes = {r["id"]: r["outcome"] for r in result["processed"]}
        self.assertEqual(outcomes, {"post-1": "published", "post-2": "failed"})

        cal = pp.load_calendar(self.calendar_path)
        statuses = {t["id"]: t["status"] for t in cal["topics"]}
        self.assertEqual(
            statuses,
            {"post-1": "published", "post-2": "failed", "planned": "planned"},
        )

    # ── Site filter ────────────────────────────────────────────────────

    def test_site_filter_only_publishes_matching_entries(self):
        self._write_calendar([
            _ready_entry(1, site="a.com"),
            _ready_entry(2, site="b.com"),
        ])
        self._write_body(1)
        self._write_body(2)
        with mock.patch.object(
            pp, "post_to_webhook", return_value=(200, {"ok": True, "url": "x"}),
        ) as mocked:
            result = pp.run(
                calendar_path=self.calendar_path, webhook="https://x", token="t",
                dry_run=False, site_filter="a.com",
            )
        self.assertEqual(len(result["processed"]), 1)
        self.assertEqual(result["processed"][0]["id"], "post-1")
        mocked.assert_called_once()

    # ── Payload shape ──────────────────────────────────────────────────

    def test_payload_includes_required_fields(self):
        self._write_calendar([_ready_entry(1, featuredImage={"url": "https://x/img.png", "alt": "a"})])
        self._write_body(1, body="# Body\n\nText.")
        captured = {}

        def capture(url, token, payload, timeout=30):
            captured["payload"] = payload
            captured["token"] = token
            captured["url"] = url
            return 200, {"ok": True, "url": "https://x/published"}

        with mock.patch.object(pp, "post_to_webhook", side_effect=capture):
            pp.run(
                calendar_path=self.calendar_path, webhook="https://hook.example",
                token="secret-token", dry_run=False, site_filter=None,
            )

        p = captured["payload"]
        self.assertEqual(p["schemaVersion"], "1")
        self.assertEqual(p["slug"], "post-1")
        self.assertEqual(p["title"], "Hook-Driven Title")
        self.assertEqual(p["primaryKeyword"], "test keyword")
        self.assertEqual(p["body"], "# Body\n\nText.")
        self.assertEqual(p["bodyFormat"], "markdown")
        self.assertEqual(p["featuredImage"], {"url": "https://x/img.png", "alt": "a"})
        self.assertEqual(p["source"], {"tool": "toprank", "skill": "content-planner", "version": "1"})
        self.assertEqual(captured["token"], "secret-token")
        self.assertEqual(captured["url"], "https://hook.example")

    # ── CLI / main ──────────────────────────────────────────────────────

    def test_main_dry_run_default_when_no_flags(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        with mock.patch.object(pp, "post_to_webhook") as mocked, \
             mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENCLAW_PUBLISH_COMMIT", None)
            os.environ.pop("NOTFAIR_PUBLISH_TOKEN", None)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = pp.main(["--calendar", str(self.calendar_path)])
        mocked.assert_not_called()
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue())
        self.assertTrue(out["dryRun"])

    def test_main_commit_via_env_var(self):
        self._write_calendar([_ready_entry(1)])
        self._write_body(1)
        with mock.patch.object(
            pp, "post_to_webhook", return_value=(200, {"ok": True, "url": "x"}),
        ) as mocked, mock.patch.dict(
            os.environ,
            {"OPENCLAW_PUBLISH_COMMIT": "1", "NOTFAIR_PUBLISH_TOKEN": "tok"},
            clear=False,
        ):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = pp.main(["--calendar", str(self.calendar_path)])
        mocked.assert_called_once()
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue())
        self.assertFalse(out["dryRun"])


if __name__ == "__main__":
    unittest.main()
