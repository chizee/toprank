import type { Task } from "@/types";

/**
 * Build the hidden kickoff message the assignee receives on first open of
 * a task's per-task chat thread. Carries the brief + operating
 * instructions — the agent has everything it needs to acknowledge and
 * start working without the user typing anything.
 *
 * Kept server-side (in orchestration/) because the format mirrors what
 * the agent's system prompt expects; changing one without the other
 * desyncs the contract.
 */
export function buildTaskKickoffMessage(task: Task): string {
  const lines: string[] = [
    "(task assignment)",
    "",
    `Task ID: ${task.id}`,
    `Title: ${task.title ?? "(untitled)"}`,
    "",
    "Brief:",
    task.brief,
    "",
  ];
  if (task.success_criteria) {
    lines.push("Success criteria:", task.success_criteria, "");
  }
  lines.push(
    "Acknowledge this task in 1-2 sentences (what you'll do + roughly how",
    "long), then start working. Use your tools (MCP, exec, etc.) to actually",
    "do the thing — don't just describe what you'd do.",
    "",
    "When the task is complete, emit at the END of your reply:",
    "",
    "<task_status>",
    `task_id: ${task.id}`,
    "status: done",
    "summary: <one line on what you did>",
    "</task_status>",
    "",
    "If you hit a real blocker, emit status: blocked + an <ask_user> or",
    "<add_comment> to the CMO. If you need user sign-off on a governed",
    "action (spend, content publish, bid change), use <request_approval>",
    "before executing.",
  );
  return lines.join("\n");
}
