import { getDb } from "@/server/db/db";
import { finishRunningGoalTick, type GoalTick } from "@/server/db/goals";
import { appendTranscriptEvent } from "@/server/sessions";

export const INTERRUPTED_TICK_SUMMARY =
  "Check interrupted because NotFair stopped or restarted before it finished.";

const RECOVERED_SUMMARY_MAX = 1_000;

type TerminalEvent = {
  kind: "final" | "error" | "lifecycle";
  payload_json: string;
};

export type TickRecoveryResult = {
  recovered: number;
  completed: number;
  failed: number;
  active: number;
};

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function payloadText(
  event: TerminalEvent,
  key: "text" | "message",
): string | null {
  try {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    const value = payload[key];
    return typeof value === "string" && value.trim()
      ? value.trim().slice(0, RECOVERED_SUMMARY_MAX)
      : null;
  } catch {
    return null;
  }
}

function terminalEvent(sessionId: string): TerminalEvent | null {
  const row = getDb()
    .prepare(
      `SELECT kind, payload_json
         FROM transcript_events
        WHERE session_id = ?
          AND (
            kind IN ('final', 'error')
            OR (
              kind = 'lifecycle'
              AND json_extract(payload_json, '$.phase') = 'done'
            )
          )
          AND (
            kind <> 'error'
            OR COALESCE(json_extract(payload_json, '$.transient'), 0) = 0
          )
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(sessionId) as TerminalEvent | undefined;
  return row ?? null;
}

function sessionExists(sessionId: string): boolean {
  return Boolean(
    getDb().prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId),
  );
}

/**
 * Reconcile check rows left "running" by the previous server process.
 *
 * A local harness subprocess belongs to the process that spawned it. At
 * boot there cannot be a live in-memory owner for a persisted running row,
 * and replaying it could duplicate external mutations. We therefore:
 *
 * - preserve a terminal final as a completed check;
 * - preserve a terminal error as a failed check;
 * - close every other partial transcript with an interruption error and
 *   mark its check failed, allowing the normal next heartbeat to continue.
 *
 * Called exactly once by the scheduler before its first sweep.
 */
export function recoverInterruptedGoalTicks(
  processAlive: (pid: number) => boolean = isProcessAlive,
): TickRecoveryResult {
  const rows = getDb()
    .prepare("SELECT * FROM goal_ticks WHERE status = 'running' ORDER BY started_at ASC")
    .all() as GoalTick[];
  const result: TickRecoveryResult = {
    recovered: 0,
    completed: 0,
    failed: 0,
    active: 0,
  };

  for (const tick of rows) {
    const terminal = tick.session_id ? terminalEvent(tick.session_id) : null;
    // A second server can share the data directory (for example, an
    // orphaned process whose server.json entry was replaced). Never
    // recover work while its owning process is still alive. Legacy rows
    // without an owner are only safe to reconcile when their transcript
    // already proves the turn ended.
    if (tick.owner_pid !== null && processAlive(tick.owner_pid)) {
      result.active += 1;
      continue;
    }
    if (tick.owner_pid === null && !terminal) {
      result.active += 1;
      continue;
    }

    if (terminal?.kind === "final" || terminal?.kind === "lifecycle") {
      const summary =
        terminal.kind === "final"
          ? payloadText(terminal, "text")
          : null;
      if (!finishRunningGoalTick(
        tick.id,
        "done",
        summary ?? tick.summary ?? "Check completed before NotFair restarted.",
      )) {
        continue;
      }
      result.recovered += 1;
      result.completed += 1;
      continue;
    }

    const summary =
      terminal?.kind === "error"
        ? payloadText(terminal, "message") ?? INTERRUPTED_TICK_SUMMARY
        : INTERRUPTED_TICK_SUMMARY;
    if (!finishRunningGoalTick(tick.id, "failed", summary)) {
      continue;
    }
    if (!terminal && tick.session_id && sessionExists(tick.session_id)) {
      appendTranscriptEvent(tick.session_id, "error", {
        kind: "error",
        message: INTERRUPTED_TICK_SUMMARY,
        transient: true,
      });
    }
    result.recovered += 1;
    result.failed += 1;
  }

  return result;
}
