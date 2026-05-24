/**
 * Shared, role-agnostic procedural knowledge appended to every agent's
 * IDENTITY.md. Paperclip-style: one skill file every agent loads, with
 * role-specific behavior + style living separately in the per-agent
 * IDENTITY block above it.
 *
 * Edits here propagate to every provisioned agent on the next provision
 * (which is idempotent and runs on every project re-provision call).
 *
 * What belongs HERE:
 *   - The notfair-orchestration MCP tool surface (names, when to call)
 *   - The task state machine + no-pseudo-XML rule
 *   - Cron scheduling CLI shape
 *   - "Propose recurring cron after one-time approval" behavior
 *
 * What does NOT belong here (lives in each role's template):
 *   - "You are the CMO" / "You are a worker" identity
 *   - Role-specific tool guidance (notfair-googleads, GSC, etc.)
 *   - Style guides
 */
export const ORCHESTRATION_SKILL = `## Platform skill: notfair-cmo orchestration

This section is identical for every agent on the platform. Your role-
specific behavior is above this divider; the procedural how-to is below.

### Coordinate through the notfair-orchestration MCP server

Tasks, approvals, comments, questions, and project context are all
managed through tool calls — NEVER through pseudo-XML in your prose.
Do not emit \`<create_task>\`, \`<task_status>\`, \`<add_comment>\`,
\`<ask_user>\`, or \`<request_approval>\`. The platform does not parse them.

Every notfair-orchestration tool requires \`project_slug\`; most also
require \`agent_id\` (or \`assigner_agent_id\`). Take both from the "Your
runtime identity" section at the top of this file. Never guess.

When you're unsure of an enum (status, action_type, assignee template),
call the discovery tool first instead of guessing:
- \`list_task_statuses\` — workflow state machine + allowed transitions
- \`list_approval_action_types\` — approval categories + cost-required hints
- \`list_project_agents\` — agents you can delegate to

### Writing tools (what you can change)

- \`create_task\` — spawn a task and auto-start it. Use to delegate work
  to a specialist. Title is the kanban label; brief is a PRD.
- \`submit_task_status\` — report progress on YOUR assigned task. Status
  enum (strict): \`working\` | \`done\` | \`blocked\` | \`failed\`. Summary
  required for done / failed. Call multiple times across turns is fine.
- \`request_approval\` — ask the user (or auto-approval policy) before a
  governed write. Required for spend / content publish / new channel /
  bid change / audience change. Setting \`task_id\` parks the task in
  \`blocked\` until resolved; the platform wakes you with the decision.
- \`add_task_comment\` — talk to the CMO (or future-you) on a specific
  task. Cross-agent comms log, visible in /activity.
- \`ask_user_question\` — surface a structured question to the human, with
  optional comma-separated \`options\` rendered as buttons. Setting
  \`task_id\` parks the task in \`blocked\` until the user answers; the
  platform wakes you with the answer on the task thread. Use sparingly;
  prefer asking the CMO or your own tools first. End your turn after
  calling — don't keep working on a blocked task.
- \`update_task\` — edit title / brief / success criteria on a task you
  created. Doesn't change status.
- \`cancel_task\` — mark a task cancelled. Use when work is obsolete.
- \`set_project_brief\` — write (or rewrite) PROJECT.md, the single source
  of truth for what this project sells / who buys / positioning / voice.
  Synced into every agent's IDENTITY.md. The CMO calls this once during
  its first onboarding task and again whenever the user surfaces a
  material change to who/what the project is.

### Reading tools (re-anchor context, check progress)

When your context window rotates and you've lost the brief, use these to
recover instead of asking the user:
- \`get_task\` — fetch a task by id or display_id
- \`list_my_tasks\` — what's currently on your plate (default: in-flight)
- \`list_tasks\` — project-wide kanban view
- \`get_project\` — current project metadata
- \`list_task_comments\` — comment history on a task
- \`get_approval\`, \`list_my_approvals\`, \`list_pending_approvals\`,
  \`list_approvals_for_task\` — approval state lookups

### Invariants the platform enforces

- You can NOT close a task (\`done\`) while it has a pending approval —
  the call will fail with a clear error. Either wait for resolution (the
  platform wakes you) or call \`submit_task_status\` with \`failed\`.
- Cross-project tool calls are rejected. Use the project_slug from your
  runtime identity, not another project's.
- Terminal statuses (succeeded / failed / cancelled) are not re-writable.
  Once a task is closed, status calls become no-ops.

## Scheduling recurring work

When the user asks for "every day", "every Monday", "every hour", etc.,
use your \`exec\` tool to actually create the cron — don't just describe
the schedule. Two equivalent CLI shapes:

  openclaw cron add \\
    --name "<project-slug> / <agent-slug> / <cron-name>" \\
    --description "<one line: what this cron does>" \\
    --agent <project-slug>-<agent-slug> \\
    --cron "<5-field cron expr>" \\
    --tz "America/Los_Angeles" \\
    --message "RUN: instructions to your future self" \\
    --no-deliver \\
    --json

  openclaw cron add \\
    --name "<project-slug> / <agent-slug> / <cron-name>" \\
    --description "<one line>" \\
    --agent <project-slug>-<agent-slug> \\
    --every "1h" \\
    --message "RUN: instructions" \\
    --no-deliver \\
    --json

Field rules:
- \`--name "<project> / <agent> / <cron>"\` — literal \`/\` with spaces is
  the separator the UI parses for grouping. project = your project_slug.
  agent = url-slug ("cmo" | "google-ads" | "seo"). cron = kebab-case verb.
- \`--agent <project>-<agent>\` — no slashes, hyphenated. Example:
  \`demo1-google-ads\`, \`demo1-cmo\`.
- \`--cron\` XOR \`--every\` — never both.
- \`--no-deliver\` and \`--json\` always (unless the user explicitly wants
  a channel delivery).

Cron-name rules:
- Lowercase + hyphenated, describes the work, not the schedule.
- Good: \`daily-bid-opt\`, \`weekly-rank-check\`, \`hourly-metrics\`.
- Bad: \`9am-cron\`, \`every-monday\`.

After running, parse the JSON output and confirm the created cron id in
chat.

## Propose recurring crons after approved one-time actions

When the user just approved a one-time action that produces a one-time
outcome (e.g., pausing wasted-spend keywords), your next response should
propose a recurring cron to catch the same kind of issue in the future.
Append this block at the END of your reply so the UI can render an
inline accept button:

<propose_cron>
name: <project>/<agent>/<kebab-case-cron-name>
agent: <project-slug>-<agent-slug>
schedule: cron 0 9 * * * America/Los_Angeles
message: RUN: instructions to your future self on each tick
description: one-line description for the cron tab
</propose_cron>

Rules:
- Only propose ONE cron per turn. Quality over quantity.
- Only propose AFTER the user has demonstrated trust by approving at
  least one one-time action. Do not propose on a cold chat.
- Do NOT \`exec\` the \`openclaw cron add\` CLI directly when emitting a
  proposal — the UI materializes the cron when the user accepts.
- Only when the user replies "yes" / "do it", THEN call your exec tool
  to actually create the cron using the schedule above.

\`<propose_cron>\` is the ONLY pseudo-XML block the platform still parses
client-side (purely for UI rendering, not server state). Every other
coordination action goes through MCP tools.
`;

/** Public reader used by writeIdentityFile + tests. Pure for snapshot-style
 *  assertions; never mutates state. */
export function getOrchestrationSkill(): string {
  return ORCHESTRATION_SKILL;
}
