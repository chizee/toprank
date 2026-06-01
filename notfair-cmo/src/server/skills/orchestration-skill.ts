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
call the \`schedule_recurring_work\` MCP tool. Do NOT shell out — there
is no \`openclaw cron\` CLI. The SQLite-backed scheduler is the only
path now and it's exposed only via this tool.

Inputs:
- \`project_slug\` — from your runtime identity above.
- \`agent_id\` — full id (e.g. \`demo1-google-ads-ana\`) of the agent
  who should receive the scheduled task assignment. Usually yourself.
- \`name\` — short kebab-case identifier of the WORK (not the schedule).
  Good: \`daily-bid-opt\`, \`weekly-quality-score\`. Bad: \`9am-cron\`,
  \`every-monday\`.
- \`cron_expr\` — standard 5-field cron expression in UTC. Embed the
  user's desired hour as UTC: 9am Pacific (UTC-7 in summer) is
  \`0 16 * * *\`; 9am Pacific in winter (UTC-8) is \`0 17 * * *\`.
- \`message\` — the prompt the schedule will send to the agent on each
  tick. Write it as instructions to your future self: be specific about
  what to do and what to report.

After the tool returns, you'll get \`{ id, name, cron_expr, next_run_at }\`.
Mention the created id in your reply so the user can correlate with the
Crons tab.

Common patterns:
- Daily morning: \`0 16 * * *\` (9am PT summer)
- Weekly Monday: \`0 16 * * 1\`
- Hourly: \`0 * * * *\`

## Propose recurring crons after approved one-time actions

When the user just approved a one-time action that produces a one-time
outcome (e.g., pausing wasted-spend keywords), your next response should
propose a recurring schedule to catch the same kind of issue in the
future. Describe the proposed schedule in prose plus the exact tool
call you would make, then wait for the user's go-ahead:

> "I'd suggest scheduling this weekly — every Monday at 9am Pacific.
> If you want, I'll set it up:
>  - name: weekly-wasted-spend-sweep
>  - cron_expr: 0 16 * * 1
>  - message: 'Re-run the wasted-spend audit and pause any keyword with
>    > $50 spend and 0 conversions in the past 7 days. Report counts.'"

Rules:
- Only propose ONE schedule per turn. Quality over quantity.
- Only propose AFTER the user has demonstrated trust by approving at
  least one one-time action. Do not propose on a cold chat.
- When the user replies "yes" / "do it", THEN call
  \`schedule_recurring_work\` with the exact fields above.
`;

/** Public reader used by writeIdentityFile + tests. Pure for snapshot-style
 *  assertions; never mutates state. */
export function getOrchestrationSkill(): string {
  return ORCHESTRATION_SKILL;
}
