import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.NOTFAIR_DATA_DIR = mkdtempSync(join(tmpdir(), "notfair-recovery-"));
});

import { getDb } from "@/server/db/db";
import { getGoalTick } from "@/server/db/goals";
import {
  appendTranscriptEvent,
  getOrCreateSession,
  listTranscriptEvents,
} from "@/server/sessions";
import {
  INTERRUPTED_TICK_SUMMARY,
  recoverInterruptedGoalTicks,
} from "./recovery";

const NOW = "2026-07-22T20:00:00.000Z";

function insertRunningTick(input: {
  id: string;
  tickNumber: number;
  sessionId?: string;
  ownerPid?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO goal_ticks
         (id, goal_id, tick_number, trigger_kind, owner_pid, session_id, status, started_at)
       VALUES (?, 'goal-1', ?, 'heartbeat', ?, ?, 'running', ?)`,
    )
    .run(
      input.id,
      input.tickNumber,
      input.ownerPid ?? null,
      input.sessionId ?? null,
      NOW,
    );
}

beforeAll(() => {
  const db = getDb();
  db.prepare(
    "INSERT INTO projects (id, slug, display_name, created_at, harness_adapter) VALUES ('p1', 'proj', 'Proj', ?, 'codex-local')",
  ).run(NOW);
  db.prepare(
    `INSERT INTO goals
       (id, project_slug, agent_id, statement, status, cadence_cron, created_at, updated_at)
     VALUES ('goal-1', 'proj', 'agent-1', 'Keep errors low', 'active', '0 * * * *', ?, ?)`,
  ).run(NOW, NOW);
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM goal_ticks").run();
  db.prepare("DELETE FROM transcript_events").run();
  db.prepare("DELETE FROM sessions").run();
});

describe("recoverInterruptedGoalTicks", () => {
  it("fails an orphaned running tick and closes its partial transcript", () => {
    const session = getOrCreateSession({
      project_slug: "proj",
      agent_id: "agent-1",
      label: "tick-1",
      harness_adapter: "codex-local",
    });
    appendTranscriptEvent(session.id, "user", { text: "check" });
    appendTranscriptEvent(session.id, "lifecycle", {
      kind: "lifecycle",
      phase: "start",
    });
    insertRunningTick({
      id: "tick-1",
      tickNumber: 1,
      sessionId: session.id,
      ownerPid: 4040,
    });

    expect(recoverInterruptedGoalTicks(() => false)).toEqual({
      recovered: 1,
      completed: 0,
      failed: 1,
      active: 0,
    });

    expect(getGoalTick("tick-1")).toMatchObject({
      status: "failed",
      summary: INTERRUPTED_TICK_SUMMARY,
    });
    const events = listTranscriptEvents(session.id);
    expect(events.at(-1)).toMatchObject({ kind: "error" });
    expect(JSON.parse(events.at(-1)!.payload_json)).toMatchObject({
      message: INTERRUPTED_TICK_SUMMARY,
    });

    expect(recoverInterruptedGoalTicks(() => false)).toEqual({
      recovered: 0,
      completed: 0,
      failed: 0,
      active: 0,
    });
    expect(listTranscriptEvents(session.id)).toHaveLength(3);
  });

  it("recovers a final event as done instead of replaying the tick", () => {
    const session = getOrCreateSession({
      project_slug: "proj",
      agent_id: "agent-1",
      label: "tick-2",
      harness_adapter: "codex-local",
    });
    appendTranscriptEvent(session.id, "final", {
      kind: "final",
      text: "The check completed before shutdown.",
    });
    insertRunningTick({ id: "tick-2", tickNumber: 2, sessionId: session.id });

    expect(recoverInterruptedGoalTicks()).toEqual({
      recovered: 1,
      completed: 1,
      failed: 0,
      active: 0,
    });
    expect(getGoalTick("tick-2")).toMatchObject({
      status: "done",
      summary: "The check completed before shutdown.",
    });
    expect(listTranscriptEvents(session.id)).toHaveLength(1);
  });

  it("preserves a terminal error as the failed tick summary without duplicating it", () => {
    const session = getOrCreateSession({
      project_slug: "proj",
      agent_id: "agent-1",
      label: "tick-3",
      harness_adapter: "codex-local",
    });
    appendTranscriptEvent(session.id, "error", {
      kind: "error",
      message: "The harness stopped unexpectedly.",
      transient: false,
    });
    insertRunningTick({ id: "tick-3", tickNumber: 3, sessionId: session.id });

    expect(recoverInterruptedGoalTicks()).toEqual({
      recovered: 1,
      completed: 0,
      failed: 1,
      active: 0,
    });
    expect(getGoalTick("tick-3")).toMatchObject({
      status: "failed",
      summary: "The harness stopped unexpectedly.",
    });
    expect(listTranscriptEvents(session.id)).toHaveLength(1);
  });

  it("recovers a stored lifecycle completion as done", () => {
    const session = getOrCreateSession({
      project_slug: "proj",
      agent_id: "agent-1",
      label: "tick-4",
      harness_adapter: "codex-local",
    });
    appendTranscriptEvent(session.id, "lifecycle", {
      kind: "lifecycle",
      phase: "done",
    });
    insertRunningTick({ id: "tick-4", tickNumber: 4, sessionId: session.id });

    expect(recoverInterruptedGoalTicks()).toEqual({
      recovered: 1,
      completed: 1,
      failed: 0,
      active: 0,
    });
    expect(getGoalTick("tick-4")).toMatchObject({
      status: "done",
      summary: "Check completed before NotFair restarted.",
    });
    expect(listTranscriptEvents(session.id)).toHaveLength(1);
  });

  it("fails a running row without a session", () => {
    insertRunningTick({ id: "tick-5", tickNumber: 5, ownerPid: 5050 });

    expect(recoverInterruptedGoalTicks(() => false)).toEqual({
      recovered: 1,
      completed: 0,
      failed: 1,
      active: 0,
    });
    expect(getGoalTick("tick-5")).toMatchObject({
      status: "failed",
      summary: INTERRUPTED_TICK_SUMMARY,
    });
  });

  it("leaves a tick owned by another live process running", () => {
    insertRunningTick({ id: "tick-6", tickNumber: 6, ownerPid: 4242 });

    expect(recoverInterruptedGoalTicks((pid) => pid === 4242)).toEqual({
      recovered: 0,
      completed: 0,
      failed: 0,
      active: 1,
    });
    expect(getGoalTick("tick-6")).toMatchObject({
      status: "running",
      owner_pid: 4242,
    });
  });

  it("leaves a legacy ownerless partial tick untouched", () => {
    insertRunningTick({ id: "tick-7", tickNumber: 7 });

    expect(recoverInterruptedGoalTicks()).toEqual({
      recovered: 0,
      completed: 0,
      failed: 0,
      active: 1,
    });
    expect(getGoalTick("tick-7")).toMatchObject({
      status: "running",
      owner_pid: null,
    });
  });

  it("does not treat a transient error as proof a legacy turn ended", () => {
    const session = getOrCreateSession({
      project_slug: "proj",
      agent_id: "agent-1",
      label: "tick-8",
      harness_adapter: "codex-local",
    });
    appendTranscriptEvent(session.id, "error", {
      kind: "error",
      message: "Reconnecting...",
      transient: true,
    });
    insertRunningTick({
      id: "tick-8",
      tickNumber: 8,
      sessionId: session.id,
    });

    expect(recoverInterruptedGoalTicks()).toEqual({
      recovered: 0,
      completed: 0,
      failed: 0,
      active: 1,
    });
    expect(getGoalTick("tick-8")?.status).toBe("running");
  });
});
