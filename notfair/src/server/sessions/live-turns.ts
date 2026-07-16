/**
 * In-process registry of live chat turns, keyed by session id. The chat
 * route registers each turn's AbortController here so the stop endpoint
 * can kill the harness subprocess on the user's explicit request —
 * distinct from a mere client disconnect, which never cancels the turn.
 * Single-process local app: module state is the source of truth (same
 * pattern as the tick runner's re-entrancy guard).
 */

const liveTurns = new Map<string, AbortController>();

export function registerLiveTurn(sessionId: string): AbortController {
  const ctrl = new AbortController();
  liveTurns.set(sessionId, ctrl);
  return ctrl;
}

/** Release only if this controller still owns the slot (races are benign). */
export function releaseLiveTurn(sessionId: string, ctrl: AbortController): void {
  if (liveTurns.get(sessionId) === ctrl) liveTurns.delete(sessionId);
}

/** Abort a session's live turn. Returns whether one was running. */
export function stopLiveTurn(sessionId: string): boolean {
  const ctrl = liveTurns.get(sessionId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}
