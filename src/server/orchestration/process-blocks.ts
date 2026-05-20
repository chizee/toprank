import { randomUUID } from "node:crypto";

import { agentExists, agentNameFor, templateForKey, type AgentTemplateKey } from "@/server/agent-templates";
import { logAgentAction } from "@/server/db/agent-actions";
import { createApproval } from "@/server/db/approvals";
import { createTask, getTask, updateTask } from "@/server/db/tasks";
import type { Task } from "@/types";

import {
  parseAddCommentBlocks,
  parseAskUserBlocks,
  parseCreateTaskBlocks,
  parseRequestApprovalBlocks,
  parseTaskStatusBlocks,
  type AddCommentBlock,
  type AskUserBlock,
  type CreateTaskBlock,
  type RequestApprovalBlock,
  type TaskStatusBlock,
} from "./blocks";

/**
 * After an assistant turn completes, scan the full reply text for
 * orchestration blocks and apply them. CMO emits <create_task> to spawn
 * work for specialists; specialists emit <task_status> to update progress.
 *
 * Failures are non-fatal — invalid blocks are logged and skipped. The
 * chat itself is unaffected; the user still sees the assistant reply.
 */

export type ProcessContext = {
  project_slug: string;
  /** Agent emitting the blocks. CMO for create_task; specialists for status. */
  agent_id: string;
};

export type ProcessOutcome = {
  tasks_created: Task[];
  task_status_updates: Array<{ task_id: string; status: string }>;
  comments_added: Array<{ task_id: string }>;
  ask_user: Array<{ task_id?: string; question: string }>;
  approvals_requested: Array<{ approval_id: string; action_type: string }>;
  errors: Array<{ kind: string; message: string }>;
};

export async function processOrchestrationBlocks(
  text: string,
  context: ProcessContext,
): Promise<ProcessOutcome> {
  const outcome: ProcessOutcome = {
    tasks_created: [],
    task_status_updates: [],
    comments_added: [],
    ask_user: [],
    approvals_requested: [],
    errors: [],
  };

  for (const block of parseCreateTaskBlocks(text)) {
    try {
      const task = await applyCreateTaskBlock(block, context);
      if (task) outcome.tasks_created.push(task);
    } catch (err) {
      outcome.errors.push({
        kind: "create_task",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const block of parseTaskStatusBlocks(text)) {
    try {
      const update = applyTaskStatusBlock(block, context);
      if (update) outcome.task_status_updates.push(update);
    } catch (err) {
      outcome.errors.push({
        kind: "task_status",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const block of parseAddCommentBlocks(text)) {
    try {
      applyAddCommentBlock(block, context);
      outcome.comments_added.push({ task_id: block.task_id });
    } catch (err) {
      outcome.errors.push({
        kind: "add_comment",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const block of parseAskUserBlocks(text)) {
    try {
      applyAskUserBlock(block, context);
      outcome.ask_user.push({ task_id: block.task_id, question: block.question });
    } catch (err) {
      outcome.errors.push({
        kind: "ask_user",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const block of parseRequestApprovalBlocks(text)) {
    try {
      const result = applyRequestApprovalBlock(block, context);
      if (result) outcome.approvals_requested.push(result);
    } catch (err) {
      outcome.errors.push({
        kind: "request_approval",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcome;
}

async function applyCreateTaskBlock(
  block: CreateTaskBlock,
  ctx: ProcessContext,
): Promise<Task | null> {
  // Validate the assignee template exists (allows synonyms like "google-ads"
  // vs "google_ads" via templateForKey's normalization).
  const template = templateForKey(block.assignee);
  if (!template) {
    throw new Error(`Unknown assignee template '${block.assignee}'`);
  }
  if (template.key === "cmo") {
    throw new Error("CMO cannot assign tasks to itself — pick a specialist");
  }

  const assigneeAgentId = agentNameFor(ctx.project_slug, template.key as AgentTemplateKey);
  if (!(await agentExists(assigneeAgentId))) {
    throw new Error(
      `Assignee agent ${assigneeAgentId} is not provisioned for this project`,
    );
  }

  const task = createTask({
    project_slug: ctx.project_slug,
    agent_id: assigneeAgentId,
    title: block.title,
    brief: block.brief,
    success_criteria: block.success_criteria ?? null,
    assigner_agent_id: ctx.agent_id,
    status: "proposed",
  });

  logAgentAction({
    project_slug: ctx.project_slug,
    agent_id: ctx.agent_id,
    action_type: "task_created",
    summary: `Created task '${task.title}' for ${template.display_name}.`,
    payload: { task_id: task.id, assignee: assigneeAgentId },
  });

  // Auto-start the delegated task. When the CMO emits <create_task>, the
  // user expects work to be in flight immediately — not parked as
  // "proposed" until someone clicks Start. The kickoff is fire-and-forget;
  // status flips proposed → running so the sidebar badge + workspace task
  // list reflect activity on the very next poll cycle.
  // Lazy import to avoid pulling the orchestration → run-task → gateway
  // chain into modules that just want createTask.
  const { startTaskIfProposed } = await import("./run-task");
  return startTaskIfProposed(task);
}

function applyTaskStatusBlock(
  block: TaskStatusBlock,
  ctx: ProcessContext,
): { task_id: string; status: string } | null {
  const task = getTask(block.task_id);
  if (!task) {
    throw new Error(`Unknown task_id '${block.task_id}'`);
  }
  if (task.project_slug !== ctx.project_slug) {
    throw new Error(
      `Cross-project task update rejected: task '${block.task_id}' belongs to '${task.project_slug}' but emitter is in '${ctx.project_slug}'`,
    );
  }
  if (task.agent_id !== ctx.agent_id) {
    throw new Error(
      `Only the assignee (${task.agent_id}) can update task '${block.task_id}'; got update from '${ctx.agent_id}'`,
    );
  }
  // Already terminal? Skip — user cancellations + earlier failure updates
  // shouldn't get overwritten by a late "done" from an agent that kept
  // running for a bit after the user moved on.
  if (
    task.status === "cancelled" ||
    task.status === "failed" ||
    task.status === "succeeded"
  ) {
    return { task_id: block.task_id, status: task.status };
  }

  // Map the agent's status vocabulary to our TaskStatus enum.
  const newStatus =
    block.status === "working"
      ? ("running" as const)
      : block.status === "done"
        ? ("succeeded" as const)
        : block.status === "blocked"
          ? ("running" as const) // still active, just stalled — caller decides
          : ("failed" as const);

  updateTask(block.task_id, {
    status: newStatus,
    result: block.summary ? { summary: block.summary } : undefined,
    error_message: block.status === "failed" ? (block.summary ?? "agent reported failure") : null,
  });

  logAgentAction({
    project_slug: ctx.project_slug,
    agent_id: ctx.agent_id,
    action_type: `task_${block.status}`,
    summary: block.summary ?? `Task ${block.status}.`,
    payload: { task_id: block.task_id, status: newStatus },
  });

  return { task_id: block.task_id, status: newStatus };
}

/**
 * V1 add_comment handler. Comments live on the agent_actions log keyed by
 * task_id so they're visible in /activity and queryable per task. A
 * dedicated task_comments table can be added in v1.1 if richer threading
 * is needed (paperclip parity).
 */
function applyAddCommentBlock(
  block: AddCommentBlock,
  ctx: ProcessContext,
): void {
  const task = getTask(block.task_id);
  if (!task) throw new Error(`Unknown task_id '${block.task_id}'`);
  if (task.project_slug !== ctx.project_slug) {
    throw new Error(`Cross-project comment rejected on task '${block.task_id}'`);
  }
  logAgentAction({
    project_slug: ctx.project_slug,
    agent_id: ctx.agent_id,
    action_type: "task_comment",
    summary: block.body,
    payload: { task_id: block.task_id },
  });
}

/**
 * V1 ask_user handler. Logged to agent_actions; the task detail page can
 * render any pending ask_user from the activity log. V1.1 should wire a
 * dedicated "answer" surface so the user's reply flows back into the
 * agent's next turn (paperclip's ask_user_questions interaction kind).
 */
function applyAskUserBlock(
  block: AskUserBlock,
  ctx: ProcessContext,
): void {
  if (block.task_id) {
    const task = getTask(block.task_id);
    if (!task) throw new Error(`Unknown task_id '${block.task_id}'`);
    if (task.project_slug !== ctx.project_slug) {
      throw new Error(`Cross-project ask_user rejected on task '${block.task_id}'`);
    }
  }
  logAgentAction({
    project_slug: ctx.project_slug,
    agent_id: ctx.agent_id,
    action_type: "ask_user",
    summary: block.question,
    payload: { task_id: block.task_id ?? null, options: block.options ?? null },
  });
}

/**
 * V1 request_approval handler. Creates a row in the approvals table that
 * the /approvals page already renders (per the existing inbox UI in
 * CEO Section 11). When the user approves, v1.1 wires the response back
 * to the agent so it can proceed; for V1 the approval is created + the
 * agent waits for the user to act manually.
 */
function applyRequestApprovalBlock(
  block: RequestApprovalBlock,
  ctx: ProcessContext,
): { approval_id: string; action_type: string } | null {
  if (block.task_id) {
    const task = getTask(block.task_id);
    if (!task) throw new Error(`Unknown task_id '${block.task_id}'`);
    if (task.project_slug !== ctx.project_slug) {
      throw new Error(`Cross-project approval rejected on task '${block.task_id}'`);
    }
  }
  const approval = createApproval({
    project_slug: ctx.project_slug,
    agent_id: ctx.agent_id,
    action_summary: block.action_summary,
    action_type: block.action_type,
    cost_estimate_usd: block.cost_estimate_usd ?? 0,
    reasoning: block.reasoning ?? null,
    payload: { task_id: block.task_id ?? null },
  });
  return { approval_id: approval.id, action_type: block.action_type };
}

/**
 * Generate a UUID for a per-task chat thread. Stable per-call; callers
 * persist it via setTaskThreadIfMissing once they decide to materialize
 * the thread (typically on the first /tasks/[id] page visit).
 */
export function generateTaskThreadId(): string {
  return randomUUID();
}
