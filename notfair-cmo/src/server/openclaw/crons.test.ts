import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tmpHome, ORIGINAL_HOME } = vi.hoisted(() => {
  // Hoisted so it runs before any imports — must be set BEFORE crons.ts
  // module-evaluates and captures OPENCLAW_HOME.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  const original = process.env.OPENCLAW_HOME;
  const tmp = mkdtempSync(joinPath(tmpdir(), "notfair-cmo-crons-"));
  process.env.OPENCLAW_HOME = tmp;
  return { tmpHome: tmp, ORIGINAL_HOME: original };
});

const openclawMock = vi.fn();
vi.mock("./cli", () => ({
  openclaw: (...args: unknown[]) => openclawMock(...args),
}));

import {
  createCron,
  disableCron,
  enableCron,
  invalidateCronCache,
  listCronsForProject,
  loadCronRuns,
  removeCron,
} from "./crons";

describe("crons module", () => {
  beforeEach(() => {
    openclawMock.mockReset();
    invalidateCronCache();
  });

  afterEach(() => {
    invalidateCronCache();
  });

  describe("listCronsForProject", () => {
    it("matches crons by 'project<sep>...' name with no surrounding spaces", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo/google-ads/morning", agentId: "demo-google-ads" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.project_slug).toBe("demo");
      expect(view.groups.length).toBe(1);
      expect(view.groups[0]!.agent).toBe("google-ads");
      expect(view.groups[0]!.crons[0]!.id).toBe("1");
    });

    it("matches crons by 'project <sep>...' name with surrounding spaces", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo / seo / weekly", agentId: "demo-seo" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups[0]!.agent).toBe("seo");
    });

    it("matches crons by agentId starting with '<project>-' even with unrelated name", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "anonymous-cron", agentId: "demo-cmo" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups.length).toBe(1);
      expect(view.groups[0]!.agent).toBe("cmo");
    });

    it("skips crons that don't match the project", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "other/seo/x", agentId: "other-seo" },
        { id: "2", name: "demo/google-ads/x", agentId: "demo-google-ads" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups.length).toBe(1);
      expect(view.groups[0]!.crons.length).toBe(1);
      expect(view.groups[0]!.crons[0]!.id).toBe("2");
    });

    it("normalizes a jobs:[] wrapper from openclaw", async () => {
      openclawMock.mockResolvedValueOnce({
        jobs: [{ id: "1", name: "demo/cmo/x", agentId: "demo-cmo" }],
      });
      const view = await listCronsForProject("demo");
      expect(view.groups.length).toBe(1);
    });

    it("normalizes a crons:[] wrapper from openclaw", async () => {
      openclawMock.mockResolvedValueOnce({
        crons: [{ id: "1", name: "demo/cmo/x", agentId: "demo-cmo" }],
      });
      const view = await listCronsForProject("demo");
      expect(view.groups.length).toBe(1);
    });

    it("returns empty groups when openclaw returns garbage", async () => {
      openclawMock.mockResolvedValueOnce("not an array");
      const view = await listCronsForProject("demo");
      expect(view.groups).toEqual([]);
    });

    it("derives agent slug from cron name when agentId is missing", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo/google-ads/morning" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups.length).toBe(1);
      expect(view.groups[0]!.agent).toBe("google-ads");
    });

    it("groups multiple crons by agent and sorts groups alphabetically", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo/seo/a", agentId: "demo-seo" },
        { id: "2", name: "demo/google-ads/a", agentId: "demo-google-ads" },
        { id: "3", name: "demo/google-ads/b", agentId: "demo-google-ads" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups.map((g) => g.agent)).toEqual(["google-ads", "seo"]);
      expect(view.groups[0]!.crons.length).toBe(2);
    });

    it("formats cron expression schedule with tz suffix", async () => {
      openclawMock.mockResolvedValueOnce([
        {
          id: "1",
          name: "demo/cmo/x",
          agentId: "demo-cmo",
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Los_Angeles" },
        },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups[0]!.crons[0]!.schedule_text).toBe(
        "0 9 * * *  ·  America/Los_Angeles",
      );
    });

    it("formats cron expression schedule without tz", async () => {
      openclawMock.mockResolvedValueOnce([
        {
          id: "1",
          name: "demo/cmo/x",
          agentId: "demo-cmo",
          schedule: { kind: "cron", expr: "0 9 * * *" },
        },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups[0]!.crons[0]!.schedule_text).toBe("0 9 * * *");
    });

    it("formats every schedule in seconds/minutes/hours/days", async () => {
      const cases: Array<[number, string]> = [
        [30_000, "every 30s"],
        [5 * 60_000, "every 5m"],
        [3 * 60 * 60_000, "every 3h"],
        [2 * 24 * 60 * 60_000, "every 2d"],
      ];
      for (const [everyMs, expected] of cases) {
        openclawMock.mockReset();
        invalidateCronCache();
        openclawMock.mockResolvedValueOnce([
          {
            id: "1",
            name: "demo/cmo/x",
            agentId: "demo-cmo",
            schedule: { kind: "every", everyMs },
          },
        ]);
        const view = await listCronsForProject("demo");
        expect(view.groups[0]!.crons[0]!.schedule_text).toBe(expected);
      }
    });

    it("dash-formats schedule for missing/unknown shapes", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo/cmo/a", agentId: "demo-cmo" },
        {
          id: "2",
          name: "demo/cmo/b",
          agentId: "demo-cmo",
          schedule: { kind: "weird" },
        },
      ]);
      const view = await listCronsForProject("demo");
      const crons = view.groups[0]!.crons;
      const byId = Object.fromEntries(crons.map((c) => [c.id, c]));
      expect(byId["1"]!.schedule_text).toBe("—");
      expect(byId["2"]!.schedule_text).toBe(JSON.stringify({ kind: "weird" }));
    });

    it("status_text falls back to 'idle' when no state on enabled cron", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo/cmo/x", agentId: "demo-cmo" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups[0]!.crons[0]!.status_text).toBe("idle");
      expect(view.groups[0]!.crons[0]!.disabled).toBe(false);
    });

    it("status_text uses lastStatus then falls back to lastRunStatus", async () => {
      openclawMock.mockResolvedValueOnce([
        {
          id: "1",
          name: "demo/cmo/a",
          agentId: "demo-cmo",
          state: { lastStatus: "ok" },
        },
        {
          id: "2",
          name: "demo/cmo/b",
          agentId: "demo-cmo",
          state: { lastRunStatus: "error" },
        },
      ]);
      const view = await listCronsForProject("demo");
      const byId = Object.fromEntries(view.groups[0]!.crons.map((c) => [c.id, c]));
      expect(byId["1"]!.status_text).toBe("ok");
      expect(byId["2"]!.status_text).toBe("error");
    });

    it("marks disabled crons (either disabled:true OR enabled:false)", async () => {
      openclawMock.mockResolvedValueOnce([
        {
          id: "1",
          name: "demo/cmo/a",
          agentId: "demo-cmo",
          disabled: true,
          state: { lastStatus: "ok" },
        },
        {
          id: "2",
          name: "demo/cmo/b",
          agentId: "demo-cmo",
          enabled: false,
        },
      ]);
      const view = await listCronsForProject("demo");
      const byId = Object.fromEntries(view.groups[0]!.crons.map((c) => [c.id, c]));
      expect(byId["1"]!.disabled).toBe(true);
      expect(byId["1"]!.status_text).toBe("disabled");
      expect(byId["2"]!.disabled).toBe(true);
    });

    it("derives short_name from last segment of name", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo/google-ads/morning-budget", agentId: "demo-google-ads" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups[0]!.crons[0]!.short_name).toBe("morning-budget");
    });

    it("propagates message + description + last_error fields", async () => {
      openclawMock.mockResolvedValueOnce([
        {
          id: "1",
          name: "demo/cmo/x",
          agentId: "demo-cmo",
          description: "a job",
          payload: { kind: "agentTurn", message: "hi" },
          state: { lastError: "blew up" },
        },
      ]);
      const view = await listCronsForProject("demo");
      const d = view.groups[0]!.crons[0]!;
      expect(d.description).toBe("a job");
      expect(d.message).toBe("hi");
      expect(d.last_error).toBe("blew up");
    });

    it("falls back to lastErrorReason when lastError missing", async () => {
      openclawMock.mockResolvedValueOnce([
        {
          id: "1",
          name: "demo/cmo/x",
          agentId: "demo-cmo",
          state: { lastErrorReason: "no creds" },
        },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups[0]!.crons[0]!.last_error).toBe("no creds");
    });

    it("formats next/last run as relative seconds/minutes/hours/days", async () => {
      const now = Date.now();
      openclawMock.mockResolvedValueOnce([
        {
          id: "1",
          name: "demo/cmo/x",
          agentId: "demo-cmo",
          state: {
            nextRunAtMs: now + 30_000,
            lastRunAtMs: now - 5 * 60_000,
          },
        },
        {
          id: "2",
          name: "demo/cmo/y",
          agentId: "demo-cmo",
          state: {
            nextRunAtMs: now + 2 * 60 * 60_000,
            lastRunAtMs: now - 3 * 24 * 60 * 60_000,
          },
        },
      ]);
      const view = await listCronsForProject("demo");
      const byId = Object.fromEntries(view.groups[0]!.crons.map((c) => [c.id, c]));
      expect(byId["1"]!.next_run_text).toMatch(/^in 30s$/);
      expect(byId["1"]!.last_run_text).toMatch(/5m ago/);
      expect(byId["2"]!.next_run_text).toMatch(/in 2h/);
      expect(byId["2"]!.last_run_text).toMatch(/3d ago/);
    });

    it("renders '—' for missing run timestamps", async () => {
      openclawMock.mockResolvedValueOnce([
        { id: "1", name: "demo/cmo/x", agentId: "demo-cmo" },
      ]);
      const view = await listCronsForProject("demo");
      expect(view.groups[0]!.crons[0]!.next_run_text).toBe("—");
      expect(view.groups[0]!.crons[0]!.last_run_text).toBe("—");
    });
  });

  describe("subprocess cache", () => {
    it("caches openclaw output within the TTL window", async () => {
      openclawMock.mockResolvedValue([{ id: "1", name: "demo/cmo/x", agentId: "demo-cmo" }]);
      // Two back-to-back calls; cache key is project_slug-agnostic.
      await listCronsForProject("demo");
      await listCronsForProject("other-project");
      expect(openclawMock).toHaveBeenCalledTimes(1);
    });

    it("invalidateCronCache forces a refetch", async () => {
      openclawMock.mockResolvedValue([]);
      await listCronsForProject("demo");
      invalidateCronCache();
      await listCronsForProject("demo");
      expect(openclawMock).toHaveBeenCalledTimes(2);
    });

    it("invalidates the cache when openclaw rejects", async () => {
      openclawMock.mockRejectedValueOnce(new Error("transient"));
      await expect(listCronsForProject("demo")).rejects.toThrow("transient");
      openclawMock.mockResolvedValueOnce([]);
      await expect(listCronsForProject("demo")).resolves.toBeTruthy();
      expect(openclawMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("mutators invalidate cache + call openclaw", () => {
    beforeEach(() => {
      openclawMock.mockResolvedValue(undefined);
    });

    it("disableCron calls 'cron disable <id>' without json", async () => {
      await disableCron("c1");
      expect(openclawMock).toHaveBeenCalledWith(["cron", "disable", "c1"], { json: false });
    });

    it("enableCron calls 'cron enable <id>' without json", async () => {
      await enableCron("c1");
      expect(openclawMock).toHaveBeenCalledWith(["cron", "enable", "c1"], { json: false });
    });

    it("removeCron calls 'cron rm <id>' without json", async () => {
      await removeCron("c1");
      expect(openclawMock).toHaveBeenCalledWith(["cron", "rm", "c1"], { json: false });
    });

    it("mutators invalidate the cron list cache", async () => {
      openclawMock.mockReset();
      openclawMock.mockResolvedValueOnce([]); // first listCronsForProject
      await listCronsForProject("demo");
      openclawMock.mockResolvedValueOnce(undefined); // disable
      await disableCron("c1");
      openclawMock.mockResolvedValueOnce([]); // refetch after invalidate
      await listCronsForProject("demo");
      // 3 calls total = list + disable + list-after-disable
      expect(openclawMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("createCron", () => {
    it("builds full name and passes cron schedule + tz", async () => {
      openclawMock.mockResolvedValueOnce({ id: "cron-id-1", name: "demo/cmo/morning" });
      const r = await createCron({
        project_slug: "demo",
        agent_slug: "cmo",
        agent_full_id: "demo-cmo",
        cron_name: "morning",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        message: "hello",
      });
      expect(r).toEqual({ id: "cron-id-1", name: "demo/cmo/morning" });
      expect(openclawMock).toHaveBeenCalledWith([
        "cron",
        "add",
        "--name",
        "demo/cmo/morning",
        "--agent",
        "demo-cmo",
        "--message",
        "hello",
        "--no-deliver",
        "--cron",
        "0 9 * * *",
        "--tz",
        "UTC",
      ]);
    });

    it("omits --tz when not provided", async () => {
      openclawMock.mockResolvedValueOnce({});
      await createCron({
        project_slug: "demo",
        agent_slug: "cmo",
        agent_full_id: "demo-cmo",
        cron_name: "morning",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        message: "hello",
      });
      const args = openclawMock.mock.calls[0]![0] as string[];
      expect(args).not.toContain("--tz");
    });

    it("uses --every for duration-based schedules", async () => {
      openclawMock.mockResolvedValueOnce({ id: "abc" });
      await createCron({
        project_slug: "demo",
        agent_slug: "cmo",
        agent_full_id: "demo-cmo",
        cron_name: "ping",
        schedule: { kind: "every", duration: "5m" },
        message: "tick",
      });
      const args = openclawMock.mock.calls[0]![0] as string[];
      expect(args).toContain("--every");
      expect(args).toContain("5m");
      expect(args).not.toContain("--cron");
    });

    it("includes --description when provided", async () => {
      openclawMock.mockResolvedValueOnce({});
      await createCron({
        project_slug: "demo",
        agent_slug: "cmo",
        agent_full_id: "demo-cmo",
        cron_name: "x",
        schedule: { kind: "cron", expr: "* * * * *" },
        message: "m",
        description: "this is the desc",
      });
      const args = openclawMock.mock.calls[0]![0] as string[];
      const idx = args.indexOf("--description");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("this is the desc");
    });

    it("coerces missing id/name to empty string / fullName", async () => {
      openclawMock.mockResolvedValueOnce(null);
      const r = await createCron({
        project_slug: "demo",
        agent_slug: "cmo",
        agent_full_id: "demo-cmo",
        cron_name: "ping",
        schedule: { kind: "every", duration: "5m" },
        message: "m",
      });
      expect(r.id).toBe("");
      expect(r.name).toBe("demo/cmo/ping");
    });
  });

  describe("loadCronRuns", () => {
    function runsPath(cronId: string): string {
      const dir = join(tmpHome, "cron", "runs");
      mkdirSync(dir, { recursive: true });
      return join(dir, `${cronId}.jsonl`);
    }

    it("returns [] when the run log file doesn't exist", () => {
      expect(loadCronRuns("nonexistent-cron", 10)).toEqual([]);
    });

    it("parses finished entries newest-first", () => {
      const p = runsPath("cron-a");
      const lines = [
        JSON.stringify({ action: "started", runAtMs: 1000 }),
        JSON.stringify({
          action: "finished",
          runAtMs: 1000,
          ts: 1100,
          status: "ok",
          summary: "did it",
          durationMs: 100,
        }),
        JSON.stringify({
          action: "finished",
          runAtMs: 2000,
          ts: 2200,
          status: "error",
          summary: "",
          error: "kaboom",
          sessionId: "sess-1",
          model: "m",
          provider: "p",
          usage: { input_tokens: 5 },
        }),
      ];
      writeFileSync(p, lines.join("\n") + "\n", "utf8");
      const runs = loadCronRuns("cron-a", 10);
      expect(runs.length).toBe(2);
      // Newest first.
      expect(runs[0]!.status).toBe("error");
      expect(runs[0]!.run_at_ms).toBe(2000);
      expect(runs[0]!.finished_at_ms).toBe(2200);
      expect(runs[0]!.error).toBe("kaboom");
      expect(runs[0]!.session_id).toBe("sess-1");
      expect(runs[0]!.model).toBe("m");
      expect(runs[0]!.provider).toBe("p");
      expect(runs[0]!.usage).toEqual({ input_tokens: 5 });
      expect(runs[1]!.status).toBe("ok");
      expect(runs[1]!.duration_ms).toBe(100);
    });

    it("respects limit cap", () => {
      const p = runsPath("cron-b");
      const lines = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ action: "finished", runAtMs: 1000 + i, ts: 1000 + i, status: "ok" }),
      );
      writeFileSync(p, lines.join("\n") + "\n", "utf8");
      const runs = loadCronRuns("cron-b", 2);
      expect(runs.length).toBe(2);
      // Newest two are runAtMs 1004 then 1003.
      expect(runs.map((r) => r.run_at_ms)).toEqual([1004, 1003]);
    });

    it("skips non-finished entries", () => {
      const p = runsPath("cron-c");
      writeFileSync(
        p,
        [
          JSON.stringify({ action: "started", runAtMs: 1000 }),
          JSON.stringify({ action: "skipped", runAtMs: 1500 }),
          JSON.stringify({ action: "finished", runAtMs: 2000, ts: 2100, status: "ok" }),
        ].join("\n") + "\n",
        "utf8",
      );
      const runs = loadCronRuns("cron-c", 10);
      expect(runs.length).toBe(1);
      expect(runs[0]!.run_at_ms).toBe(2000);
    });

    it("skips entries missing runAtMs or with invalid JSON", () => {
      const p = runsPath("cron-d");
      writeFileSync(
        p,
        [
          "not json at all",
          JSON.stringify({ action: "finished" }), // no runAtMs
          JSON.stringify({ action: "finished", runAtMs: 0 }),
          JSON.stringify({ action: "finished", runAtMs: 5000, status: "ok" }),
          "",
        ].join("\n"),
        "utf8",
      );
      const runs = loadCronRuns("cron-d", 10);
      expect(runs.length).toBe(1);
      expect(runs[0]!.run_at_ms).toBe(5000);
    });

    it("provides sensible defaults for missing fields", () => {
      const p = runsPath("cron-e");
      writeFileSync(
        p,
        JSON.stringify({ action: "finished", runAtMs: 1000 }) + "\n",
        "utf8",
      );
      const runs = loadCronRuns("cron-e", 10);
      expect(runs[0]!.finished_at_ms).toBe(1000); // ts missing -> falls back to runAtMs
      expect(runs[0]!.status).toBe("unknown");
      expect(runs[0]!.summary).toBe("");
      expect(runs[0]!.error).toBeUndefined();
      expect(runs[0]!.usage).toBeUndefined();
    });
  });
});

// Restore env for downstream tests sharing the process.
afterAll(() => {
  if (ORIGINAL_HOME) process.env.OPENCLAW_HOME = ORIGINAL_HOME;
  else delete process.env.OPENCLAW_HOME;
});
