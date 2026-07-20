/**
 * Turn-state derivation from committed transcript events.
 *
 * A turn can be running that the viewing tab didn't start — another tab,
 * a page reload mid-turn, or a dropped SSE stream (the backend keeps
 * going; disconnect ≠ cancel). The transcript itself is the source of
 * truth: the harness writes a lifecycle "start" when a turn begins and
 * transcript-tail surfaces its final as lifecycle "done", so a trailing
 * "start" with no "done" after it means the agent is still working.
 */

type LifecycleLike = { kind: string; ts: number; phase?: string };

export type OpenTurn = {
  /** ts of the lifecycle "start" that opened the still-running turn. */
  startedAt: number;
  /** ts of the newest committed event — the staleness anchor. */
  lastEventTs: number;
};

/**
 * The still-open turn implied by the event log, or null when the last
 * turn completed. Scans backward to the nearest turn boundary so earlier
 * completed turns in the same thread can't mask a live one (or fake one).
 */
export function findOpenTurn(events: readonly LifecycleLike[]): OpenTurn | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "lifecycle") continue;
    if (e.phase === "done") return null;
    if (e.phase === "start") {
      return { startedAt: e.ts, lastEventTs: events[events.length - 1]!.ts };
    }
  }
  return null;
}

/**
 * No committed event for this long means the run is treated as orphaned
 * (server restart mid-turn never writes a final). Live turns emit tool
 * and delta events well inside this window, so a healthy turn can't go
 * stale; the indicator simply returns when events resume.
 */
export const OPEN_TURN_STALE_MS = 10 * 60_000;

export function isOpenTurnLive(turn: OpenTurn | null, now: number): boolean {
  return turn !== null && now - turn.lastEventTs < OPEN_TURN_STALE_MS;
}
