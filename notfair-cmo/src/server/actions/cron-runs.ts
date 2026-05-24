"use server";

import { loadCronRuns, type CronRun } from "@/server/openclaw/crons";
import { tickAtOrBefore } from "@/server/openclaw/cron-schedule";

export type CronRunWithTick = CronRun & {
  /**
   * The scheduled tick (ms epoch) this run belongs to. Computed by walking the
   * cron schedule backwards from `runAtMs` and taking the most recent tick at
   * or before it. Lets the UI match a run to the calendar occurrence the user
   * clicked, regardless of how late the scheduler fired.
   */
  owning_occurrence_at_ms?: number;
};

export type ScheduleInput =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; everyMs: number; anchorMs?: number };

export type GetCronRunsResult =
  | { ok: true; runs: CronRunWithTick[] }
  | { ok: false; error: string };

export async function getCronRunsAction(
  cron_id: string,
  schedule: ScheduleInput | null,
  limit = 100,
): Promise<GetCronRunsResult> {
  try {
    const raw = loadCronRuns(cron_id, limit);
    const enriched: CronRunWithTick[] = raw.map((r) => ({
      ...r,
      owning_occurrence_at_ms: schedule
        ? tickAtOrBefore(schedule, r.run_at_ms)
        : undefined,
    }));
    return { ok: true, runs: enriched };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
