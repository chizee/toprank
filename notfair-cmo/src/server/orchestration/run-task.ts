import {
  buildPendingSessionKey,
} from "@/server/openclaw/sessions";
import { streamChatViaGateway } from "@/server/openclaw/gateway-client";
import {
  openShadowWriter,
  shadowStreamEvent,
} from "@/server/openclaw/shadow-transcript";
import { claimProposedTask, setTaskThreadIfMissing, updateTask } from "@/server/db/tasks";
import type { Task } from "@/types";

import {
  buildTaskKickoffMessage,
  generateTaskThreadId,
} from "./task-kickoff";

/**
 * Idempotent "claim and kickoff" — atomically flips a proposed task to
 * running and fires the server-side kickoff. No-op when the row is already
 * running, terminal, or missing. Used by `<create_task>` handling and the
 * onboarding audit-task path; both callers operate on freshly-created tasks.
 *
 * The claim is a conditional SQL UPDATE (`WHERE status = 'proposed'`), so
 * even if a stale in-memory `task` snapshot is passed in, the DB cannot
 * regress a terminal row back to running.
 *
 * Returns the post-transition task (running on success, the input task
 * otherwise). The kickoff runs fire-and-forget — callers shouldn't await it.
 */
export function startTaskIfProposed(task: Task): Task {
  const claimed = claimProposedTask(task.id);
  if (!claimed) return task;
  void runTaskKickoffServerSide(claimed).catch((err) => {
    console.error("[start-task] kickoff failed:", err);
  });
  return claimed;
}

/**
 * Server-side kickoff for a task. Consumes the full gateway stream (no SSE
 * pipe to a client) and applies orchestration blocks the assignee emits.
 * Used by the "Start all" button on the agent Tasks tab so the agent
 * starts working immediately without the user opening each task's
 * detail page.
 *
 * Returns when the agent has finished its turn AND orchestration blocks
 * have been processed. Errors are logged + the task is marked failed.
 */
export async function runTaskKickoffServerSide(task: Task): Promise<void> {
  // Lazily mint the thread on first kickoff if the task didn't have one
  // (e.g., user never opened /tasks/[id]). Stable forever after.
  let finalTask = task;
  if (!finalTask.thread_id) {
    const updated = setTaskThreadIfMissing(task.id, generateTaskThreadId());
    if (updated) finalTask = updated;
    if (!finalTask.thread_id) {
      throw new Error(`Failed to assign thread_id for task ${task.id}`);
    }
  }

  const sessionKey = buildPendingSessionKey(finalTask.agent_id, finalTask.thread_id);
  const kickoffMessage = buildTaskKickoffMessage(finalTask);

  // Tee gateway events to a shadow JSONL the browser can tail. OpenClaw's
  // codex-app-server backend buffers session.jsonl until session-end and
  // doesn't emit per-message broadcasts during the turn, so without the
  // shadow there's no way for the UI to render tokens live for tasks
  // kicked off server-side. The shadow uses the same OpenClaw-style
  // schema as session.jsonl so transcript-tail can read both with the
  // same parser.
  const shadow = await openShadowWriter(finalTask.agent_id, finalTask.thread_id);

  // We drain the stream so the agent's turn fully runs, but we no longer
  // post-process the buffer for pseudo-XML blocks — any side effects
  // (task_status, comments, approvals) happen via the agent calling
  // notfair-orchestration MCP tools mid-stream.
  console.log(
    `[run-task] kickoff start task=${finalTask.id} agent=${finalTask.agent_id} thread=${finalTask.thread_id}`,
  );
  // Retry on the post-provisioning race: `openclaw agents add` updates the
  // config file but the gateway's pinned runtime snapshot needs a moment
  // before it sees the new agent. Until that catches up, chat.send fails
  // with INVALID_REQUEST "Agent '<id>' no longer exists in configuration".
  // 2s/4s/8s backoff covers a ~14s race window we've observed in dev.
  const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
  let lastError: unknown = null;
  let streamed = false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      for await (const evt of streamChatViaGateway({
        sessionKey,
        sessionId: finalTask.thread_id,
        message: kickoffMessage,
      })) {
        try {
          await shadowStreamEvent(shadow, evt);
        } catch (err) {
          console.error("[run-task] shadow write failed:", err);
        }
        if (evt.kind === "error") {
          throw new Error(evt.message);
        }
      }
      streamed = true;
      break;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isAgentNotInConfigError(message) || attempt >= RETRY_DELAYS_MS.length) {
        break;
      }
      const delay = RETRY_DELAYS_MS[attempt]!;
      console.warn(
        `[run-task] gateway snapshot stale for ${finalTask.agent_id}; retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (streamed) {
    await shadow.close();
    console.log(`[run-task] kickoff stream done task=${finalTask.id}`);
    return;
  }
  await shadow.close().catch(() => undefined);
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(
    `[run-task] kickoff failed task=${finalTask.id} agent=${finalTask.agent_id}: ${message}`,
  );
  updateTask(finalTask.id, {
    status: "failed",
    error_message: message,
  });
}

/**
 * Matches the gateway's "Agent '<id>' no longer exists in configuration"
 * INVALID_REQUEST. Surfaced when the gateway hasn't refreshed its agents
 * snapshot yet after a fresh `openclaw agents add`. Idempotently retryable.
 */
function isAgentNotInConfigError(message: string): boolean {
  return message.includes("no longer exists in configuration");
}
