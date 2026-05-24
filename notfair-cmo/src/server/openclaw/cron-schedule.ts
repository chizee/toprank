import { CronExpressionParser } from "cron-parser";
import type { DisplayCron } from "./crons";
import { loadCronRuns } from "./crons";

export type CronOccurrence = {
  /** ms epoch */
  at: number;
  cron_id: string;
  cron_name: string;
  short_name: string;
  agent_id: string;
  agent_slug: string;
  schedule_text: string;
  /** Raw status string from OpenClaw when a matching run is found. */
  run_status?: string;
};

type ScheduleInput =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: string; [k: string]: unknown };

/**
 * Compute upcoming occurrences for one cron up to `until` (ms epoch).
 * Returns at most `maxPerCron` entries — high-frequency crons are capped so
 * we don't render thousands of chips for an every-second job.
 */
export function expandSchedule(
  cron_id: string,
  schedule: ScheduleInput | undefined,
  range: { from: number; until: number },
  meta: Pick<DisplayCron, "name" | "short_name" | "agent_id"> & { agent_slug: string; schedule_text: string },
  maxPerCron = 60,
): CronOccurrence[] {
  if (!schedule) return [];
  const { from, until } = range;
  const out: CronOccurrence[] = [];

  const make = (at: number): CronOccurrence => ({
    at,
    cron_id,
    cron_name: meta.name,
    short_name: meta.short_name,
    agent_id: meta.agent_id,
    agent_slug: meta.agent_slug,
    schedule_text: meta.schedule_text,
  });

  if (schedule.kind === "cron" && typeof (schedule as { expr?: unknown }).expr === "string") {
    const s = schedule as { expr: string; tz?: string };
    try {
      const it = CronExpressionParser.parse(s.expr, {
        currentDate: new Date(from),
        endDate: new Date(until),
        tz: s.tz,
      });
      while (out.length < maxPerCron) {
        try {
          const next = it.next();
          out.push(make(next.toDate().getTime()));
        } catch {
          break;
        }
      }
    } catch {
      return [];
    }
    return out;
  }

  if (schedule.kind === "every" && typeof (schedule as { everyMs?: unknown }).everyMs === "number") {
    const s = schedule as { everyMs: number; anchorMs?: number };
    if (s.everyMs <= 0) return [];
    const anchor = typeof s.anchorMs === "number" ? s.anchorMs : from;
    // First occurrence at or after `from`.
    let next = anchor;
    if (anchor < from) {
      const k = Math.ceil((from - anchor) / s.everyMs);
      next = anchor + k * s.everyMs;
    }
    while (next <= until && out.length < maxPerCron) {
      out.push(make(next));
      next += s.everyMs;
    }
    return out;
  }

  return [];
}

/**
 * Find the most recent scheduled tick at or before `at` for a given schedule.
 * Used to attribute a cron run (whose `runAtMs` is when the scheduler actually
 * fired, often 5-10 minutes after the nominal tick) back to the calendar
 * occurrence it belongs to.
 *
 * Returns the tick's ms epoch, or `undefined` if no tick before `at` is in the
 * lookback window (defaults to 14 days, enough to catch the previous tick of
 * any reasonable daily/weekly schedule).
 */
export function tickAtOrBefore(
  schedule: ScheduleInput | undefined,
  at: number,
  lookbackMs = 14 * 24 * 60 * 60 * 1000,
): number | undefined {
  if (!schedule) return undefined;
  const from = at - lookbackMs;

  if (schedule.kind === "cron" && typeof (schedule as { expr?: unknown }).expr === "string") {
    const s = schedule as { expr: string; tz?: string };
    try {
      const it = CronExpressionParser.parse(s.expr, {
        currentDate: new Date(from),
        endDate: new Date(at + 1),
        tz: s.tz,
      });
      let last: number | undefined;
      for (let i = 0; i < 10_000; i++) {
        try {
          const t = it.next().toDate().getTime();
          if (t > at) break;
          last = t;
        } catch {
          break;
        }
      }
      return last;
    } catch {
      return undefined;
    }
  }

  if (schedule.kind === "every" && typeof (schedule as { everyMs?: unknown }).everyMs === "number") {
    const s = schedule as { everyMs: number; anchorMs?: number };
    if (s.everyMs <= 0) return undefined;
    const anchor = typeof s.anchorMs === "number" ? s.anchorMs : at;
    if (anchor > at) return undefined;
    const k = Math.floor((at - anchor) / s.everyMs);
    return anchor + k * s.everyMs;
  }

  return undefined;
}

/**
 * Annotate occurrences with their owning run's status (when one exists in the
 * cron run log). Mutates and returns the list for caller convenience.
 *
 * Reads `~/.openclaw/cron/runs/<cronId>.jsonl` per unique cron in the input.
 * Each run's owning nominal tick is computed via `tickAtOrBefore` so late-fired
 * runs still match their intended occurrence.
 */
export function annotateOccurrencesWithRunStatus(
  occurrences: CronOccurrence[],
  schedulesByCronId: Map<string, ScheduleInput | undefined>,
): CronOccurrence[] {
  // Group occurrences by cron so we hit the run log at most once per cron.
  const byCron = new Map<string, CronOccurrence[]>();
  for (const occ of occurrences) {
    const arr = byCron.get(occ.cron_id) ?? [];
    arr.push(occ);
    byCron.set(occ.cron_id, arr);
  }
  for (const [cronId, occs] of byCron) {
    const schedule = schedulesByCronId.get(cronId);
    if (!schedule) continue;
    const runs = loadCronRuns(cronId, 200);
    // Index runs by owning tick for O(1) lookup.
    const statusByTick = new Map<number, string>();
    for (const run of runs) {
      const tick = tickAtOrBefore(schedule, run.run_at_ms);
      if (tick != null && !statusByTick.has(tick)) {
        statusByTick.set(tick, run.status);
      }
    }
    for (const o of occs) {
      const s = statusByTick.get(o.at);
      if (s) o.run_status = s;
    }
  }
  return occurrences;
}

/**
 * Expand a list of crons into a flat occurrence list grouped by day-of-week.
 * Days are in user local time (matches what the user sees in the calendar).
 */
export function groupOccurrencesByDay(
  occurrences: CronOccurrence[],
  startOfFirstDay: number,
  numDays: number,
): CronOccurrence[][] {
  const days: CronOccurrence[][] = Array.from({ length: numDays }, () => []);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const o of occurrences) {
    const dayIndex = Math.floor((o.at - startOfFirstDay) / dayMs);
    if (dayIndex < 0 || dayIndex >= numDays) continue;
    days[dayIndex]!.push(o);
  }
  for (const day of days) day.sort((a, b) => a.at - b.at);
  return days;
}
