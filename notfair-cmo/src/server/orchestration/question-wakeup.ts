import {
  buildPendingSessionKey,
  findSessionBySessionId,
} from "@/server/openclaw/sessions";
import { streamChatViaGateway } from "@/server/openclaw/gateway-client";
import {
  parseQuestionOptions,
} from "@/server/db/questions";
import { getTask, setTaskThreadIfMissing, unblockTask } from "@/server/db/tasks";
import type { Question } from "@/types";

import { generateTaskThreadId } from "./task-kickoff";

/**
 * After the user answers (or cancels) a question raised by ask_user_question,
 * deliver a [SYSTEM] turn into the task's chat thread so the agent picks up
 * the resolution on its next turn. Mirrors approval-wakeup.ts.
 *
 * - answered → task unblocks, agent receives the question + chosen option +
 *   any free-text comment.
 * - cancelled → task STAYS blocked (the user dismissed without resolving).
 *   The agent is not woken; the question simply disappears from the
 *   workspace and the task remains parked until the agent / user takes
 *   the next step.
 *
 * No-op when the question isn't anchored to a task — free-standing asks
 * surface only in the project inbox and never park anything.
 */
export async function wakeTaskOnQuestionResolution(question: Question): Promise<void> {
  if (!question.task_id) return;
  if (question.status === "cancelled") return;
  if (question.status !== "answered") return;

  const task = getTask(question.task_id);
  if (!task) return;
  if (
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "cancelled"
  ) {
    return;
  }

  unblockTask(task.id);

  // Lazy thread mint so a free-floating ask (no prior message) still has
  // somewhere to deliver the [SYSTEM] turn.
  let threadId = task.thread_id;
  if (!threadId) {
    const minted = setTaskThreadIfMissing(task.id, generateTaskThreadId());
    if (minted?.thread_id) threadId = minted.thread_id;
  }
  if (!threadId) {
    console.error(`[question-wakeup] no thread_id for task ${task.id}`);
    return;
  }

  const known = findSessionBySessionId(task.agent_id, threadId);
  const sessionKey =
    known?.sessionKey ?? buildPendingSessionKey(task.agent_id, threadId);

  const message = buildAnswerMessage(question);

  try {
    for await (const evt of streamChatViaGateway({
      sessionKey,
      sessionId: threadId,
      message,
    })) {
      if (evt.kind === "error") throw new Error(evt.message);
    }
  } catch (err) {
    console.error(
      `[question-wakeup] gateway stream failed for task ${task.id}:`,
      err,
    );
  }
}

function buildAnswerMessage(question: Question): string {
  const options = parseQuestionOptions(question);
  const chosen =
    question.answer_option_index != null
      ? (options[question.answer_option_index] ?? null)
      : null;
  const note = question.answer_text?.trim() || null;

  // Compose a single "Answer: …" line that's unambiguous no matter how
  // the user replied: option only, free-text only, or both.
  let answerLine: string;
  if (chosen && note) {
    answerLine = `Answer: ${chosen} — ${note}`;
  } else if (chosen) {
    answerLine = `Answer: ${chosen}`;
  } else if (note) {
    answerLine = `Answer: ${note}`;
  } else {
    answerLine = "Answer: (the user submitted an empty response — re-ask if needed)";
  }

  return [
    `[SYSTEM] The user answered question #${question.id.slice(0, 8)}.`,
    `Question: ${question.prompt}`,
    answerLine,
    "",
    "The task has been unblocked. Continue your work using this answer. End your turn with `submit_task_status` (working / done / failed / blocked) when appropriate.",
  ].join("\n");
}
