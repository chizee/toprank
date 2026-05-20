import {
  buildPendingSessionKey,
  findSessionBySessionId,
  loadSessionHistory,
  type ChatMessage,
} from "@/server/openclaw/sessions";

/**
 * Resolve `threadId → (sessionKey, history)` for an agent.
 *
 * Why this helper exists: the URL threadId we mint is the LABEL half of
 * OpenClaw's sessionKey (`agent:<agent>:<label>`), NOT OpenClaw's internal
 * `sessionId` (a different UUID OpenClaw assigns when it writes the
 * transcript JSONL on first turn). loadSessionHistory takes that internal
 * sessionId. Passing the URL threadId directly silently returns [] for any
 * existing thread — which then trips autoKickoff and re-runs the agent.
 *
 * Both the agent's per-thread chat page and the per-task chat thread on
 * /tasks/[id] use this helper so the discrepancy can't bite again.
 */
export function loadThreadHistory(
  agentFullId: string,
  threadId: string,
): { sessionKey: string; history: ChatMessage[] } {
  const existing = findSessionBySessionId(agentFullId, threadId);
  const sessionKey =
    existing?.sessionKey ?? buildPendingSessionKey(agentFullId, threadId);
  const history = existing
    ? loadSessionHistory(agentFullId, existing.sessionId)
    : [];
  return { sessionKey, history };
}

import type { Task } from "@/types";

/**
 * Defense-in-depth guard for the per-task auto-kickoff. We only fire the
 * hidden kickoff when:
 *   1. The task is still proposed (hasn't started yet), AND
 *   2. The thread has no history (the agent hasn't sent any reply).
 *
 * The status guard is the load-bearing one — even if history loading
 * regresses (the bug that caused this helper to exist), a succeeded task
 * still never auto-re-fires. The history guard catches the rarer case of
 * a proposed task whose first kickoff already wrote a partial reply
 * before crashing.
 */
export function shouldAutoKickoffTask(
  task: Task,
  history: ChatMessage[],
): boolean {
  if (task.status !== "proposed") return false;
  if (history.length > 0) return false;
  return true;
}
