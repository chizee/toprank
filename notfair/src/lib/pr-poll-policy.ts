/**
 * Adaptive polling policy for open pull requests — pure functions shared
 * by the db layer (which stamps next_sync_at on every write) and tests.
 *
 * The centralized 30s scheduler sweep syncs a PR when its own
 * `next_sync_at` arrives; this policy decides how far out that is. The
 * interval keys off time since the PR's last OBSERVED activity (state /
 * review decision / comment count change): hot PRs — just opened, just
 * reviewed — poll fast; a PR that has sat quiet for days decays toward
 * an hourly cap. Any observed change resets the clock to the fast lane.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** How long to wait before the next GitHub check, given quietness. */
export function nextSyncDelayMs(msSinceActivity: number): number {
  if (msSinceActivity < 1 * HOUR) return 2 * MINUTE;
  if (msSinceActivity < 24 * HOUR) return 10 * MINUTE;
  if (msSinceActivity < 72 * HOUR) return 30 * MINUTE;
  return 60 * MINUTE;
}

/** Retry delay after a failed sync (gh missing, network, rate limit). */
export const SYNC_ERROR_RETRY_MS = 5 * MINUTE;

/**
 * Compute the next_sync_at for an OPEN PR from "now" and its last
 * activity timestamp. Terminal PRs never poll — callers store NULL.
 */
export function computeNextSyncAt(
  nowIso: string,
  lastActivityAtIso: string,
): string {
  const now = Date.parse(nowIso);
  const activity = Date.parse(lastActivityAtIso);
  const since = Number.isFinite(activity) ? Math.max(0, now - activity) : 0;
  return new Date(now + nextSyncDelayMs(since)).toISOString();
}
