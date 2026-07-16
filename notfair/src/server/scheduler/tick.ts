import { runDueGoalTicks } from "@/server/goals/tick";
import { syncDueGoalPrs } from "@/server/goals/pr-sync";

/**
 * The heartbeat loop. Started once on boot (src/instrumentation.ts); a
 * 30s interval runs two due-work checks — both cheap local SQL reads
 * that only spawn real work when a per-row timestamp has arrived:
 *
 *  - goal ticks (goals.next_tick_at — the goal's agreed cadence)
 *  - open-PR freshness (goal_prs.next_sync_at — the adaptive poll
 *    schedule from pr-poll-policy; GitHub is only called for due PRs)
 *
 * This is the ONLY scheduler in the product.
 */
let started = false;
let timer: NodeJS.Timeout | null = null;
const TICK_INTERVAL_MS = 30_000;

function sweep(): void {
  runDueGoalTicks().catch((err) =>
    console.error("[scheduler] goal tick sweep failed:", err),
  );
  syncDueGoalPrs().catch((err) =>
    console.error("[scheduler] PR freshness sweep failed:", err),
  );
}

export function ensureSchedulerRunning(): void {
  if (started) return;
  started = true;
  timer = setInterval(sweep, TICK_INTERVAL_MS);
  // First sweep on the next event-loop turn so callers return immediately.
  setImmediate(sweep);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
