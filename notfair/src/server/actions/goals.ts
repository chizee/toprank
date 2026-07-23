"use server";

import { revalidatePath } from "next/cache";
import {
  archiveAchievedGoal,
  continueAchievedGoal,
  createGoal,
  deleteGoalsForAgent,
  endActionObservation,
  getGoal,
  getGoalAction,
  getGoalForAgent,
  renameGoal,
  reviewGoalAction,
  setGoalPinned,
  setGoalStatus,
  USER_ACTION_PREFIX,
} from "@/server/db/goals";
import { cascadeDeleteAgentArtifacts } from "@/server/agents/cascade-delete";
import { getProject } from "@/server/db/projects";
import {
  goalAgentIdFor,
  goalAgentUrlSlug,
  provisionGoalAgent,
} from "@/server/goals/provision";
import { agentExistsOnDisk, listProjectAgents } from "@/server/agent-meta";
import { runGoalIntake } from "@/server/goals/intake";
import { runGoalTick } from "@/server/goals/tick";
import { syncGoalIdentity } from "@/server/goals/provision";
import { listCheckRows, type CheckFilter, type CheckRow } from "@/server/goals/checks";

export type GoalActionResult = {
  ok: boolean;
  error?: string;
  goal_id?: string;
  agent_slug?: string;
};

/** Next free sequential goal number for the project (goal-1, goal-2, …). */
async function nextGoalNumber(project_slug: string): Promise<number> {
  const agents = await listProjectAgents(project_slug);
  let max = 0;
  for (const a of agents) {
    const m = a.slug.match(/^goal-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  // Defensive: skip over any orphaned workspace dirs.
  while (await agentExistsOnDisk(goalAgentIdFor(project_slug, n))) n++;
  return n;
}

/**
 * Mint a new goal from an AMBITION. Goals are the identity — the agent
 * behind one is anonymous plumbing with a sequential id. The statement
 * seeds the goal row and an intake turn fires immediately, so the user
 * lands in a chat where the agent is already working out how to measure
 * it.
 */
export async function createGoalAgentAction(input: {
  project_slug: string;
  statement: string;
  /**
   * Platform focus picked in the creation form (a `GoalPlatform.focus`
   * line, e.g. "SEO / organic search — measure via the
   * notfair-googlesearchconsole MCP"). Threaded into the intake kickoff
   * only — the statement stays the user's words.
   */
  focus?: string | null;
}): Promise<GoalActionResult> {
  const project = getProject(input.project_slug);
  if (!project) return { ok: false, error: "Project not found." };

  const statement = input.statement.trim();
  if (!statement) return { ok: false, error: "Say what you want to achieve." };

  const n = await nextGoalNumber(project.slug);
  const agent_id = goalAgentIdFor(project.slug, n);
  const urlSlug = goalAgentUrlSlug(n);

  let goal;
  try {
    goal = createGoal({ project_slug: project.slug, agent_id, statement });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await provisionGoalAgent({ goal, urlSlug });
  } catch (err) {
    // Roll back so a broken provision doesn't strand a live goal row.
    setGoalStatus(goal.id, "killed", "provisioning failed");
    return {
      ok: false,
      error: `Agent provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The agent starts working immediately; the goal screen's embedded
  // chat streams it live.
  void runGoalIntake(goal, { focus: input.focus }).catch((err) =>
    console.error("[goal-intake] kickoff failed:", err),
  );

  revalidatePath("/", "layout");
  return {
    ok: true,
    goal_id: goal.id,
    agent_slug: urlSlug,
  };
}

export async function pauseGoalAction(goal_id: string): Promise<GoalActionResult> {
  const goal = setGoalStatus(goal_id, "paused", "paused by user");
  if (!goal) return { ok: false, error: "Goal not found." };
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function resumeGoalAction(goal_id: string): Promise<GoalActionResult> {
  const goal = getGoal(goal_id);
  if (!goal) return { ok: false, error: "Goal not found." };
  if (goal.status !== "paused") {
    return { ok: false, error: `Goal is ${goal.status}, not paused.` };
  }
  setGoalStatus(goal_id, "active", "resumed by user");
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Close the goal. The agent stays (its chat history and workspace remain
 * browsable); a closed agent simply never ticks again. Deleting the agent
 * entirely happens in its Settings danger zone.
 */
export async function killGoalAction(
  goal_id: string,
  reason?: string,
): Promise<GoalActionResult> {
  const goal = setGoalStatus(goal_id, "killed", reason?.trim() || "closed by user");
  if (!goal) return { ok: false, error: "Goal not found." };
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Remove a completed goal from daily navigation while preserving its
 * achievement, agent workspace, conversation, checks, and evidence.
 */
export async function archiveCompletedGoalAction(
  goal_id: string,
): Promise<GoalActionResult> {
  const goal = archiveAchievedGoal(goal_id);
  if (!goal) {
    return { ok: false, error: "Only a completed goal can be archived." };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Continue an achieved goal with a more ambitious target. The metric and
 * history stay intact, the heartbeat restarts, and an immediate check lets
 * the same agent re-anchor on the new milestone.
 */
export async function continueCompletedGoalAction(
  goal_id: string,
  input: {
    target_value: number;
    deadline?: string | null;
    label?: string | null;
  },
): Promise<GoalActionResult> {
  const deadline = input.deadline?.trim() || null;
  if (
    deadline &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) ||
      Number.isNaN(new Date(`${deadline}T23:59:59`).getTime()))
  ) {
    return { ok: false, error: "Enter a valid deadline." };
  }
  if (
    deadline &&
    new Date(`${deadline}T23:59:59`).getTime() < Date.now()
  ) {
    return { ok: false, error: "Choose today or a future deadline." };
  }
  const label = input.label?.trim() || null;
  if (label && label.length > 120) {
    return { ok: false, error: "Keep the goal name to 120 characters." };
  }

  let goal;
  try {
    goal = continueAchievedGoal(goal_id, {
      target_value: input.target_value,
      deadline,
      short_label: label,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!goal) {
    return { ok: false, error: "This goal is no longer awaiting a next step." };
  }

  void syncGoalIdentity(goal).catch((err) =>
    console.warn("[goal-actions] continued-goal identity sync failed:", err),
  );
  void runGoalTick(goal, "manual").catch((err) =>
    console.error("[goal-actions] continued-goal check failed:", err),
  );
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Rename the goal's display label (the sidebar/board handle). */
export async function renameGoalAction(
  goal_id: string,
  label: string,
): Promise<GoalActionResult> {
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "Name can't be empty." };
  const goal = renameGoal(goal_id, trimmed);
  if (!goal) return { ok: false, error: "Goal not found." };
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Pin/unpin the goal to the top of the sidebar rail. */
export async function setGoalPinnedAction(
  goal_id: string,
  pinned: boolean,
): Promise<GoalActionResult> {
  if (!getGoal(goal_id)) return { ok: false, error: "Goal not found." };
  setGoalPinned(goal_id, pinned);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Delete the goal AND its agent — workspace dir, chat history, MCP
 * registrations, every goal row. Unlike closing (killGoalAction), nothing
 * survives; this is the "it never happened" path.
 */
export async function deleteGoalAction(goal_id: string): Promise<GoalActionResult> {
  const goal = getGoal(goal_id);
  if (!goal) return { ok: false, error: "Goal not found." };
  await cascadeDeleteAgentArtifacts(goal.project_slug, goal.agent_id);
  deleteGoalsForAgent(goal.agent_id);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Manual unlock: end an action's observation window now. The resources
 * release immediately; the action becomes due for review, so the agent
 * scores its outcome on the next check exactly as it would at expiry.
 */
export async function releaseLockAction(action_id: string): Promise<GoalActionResult> {
  const released = endActionObservation(action_id);
  if (!released) {
    return { ok: false, error: "Lock not found — it may already be released." };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * "Mark handled" on a Needs-you escalation. The user says they made the
 * fix; the action closes so the card stops nagging. If telemetry later
 * proves otherwise, the agent's blocked-on-user rule re-escalates with a
 * fresh decision action — acknowledgment is cheap, lying to the loop isn't.
 */
export async function markUserActionHandledAction(
  action_id: string,
): Promise<GoalActionResult> {
  const action = getGoalAction(action_id);
  if (
    !action ||
    action.kind !== "decision" ||
    !action.description.startsWith(USER_ACTION_PREFIX)
  ) {
    return { ok: false, error: "Not an open user-action escalation." };
  }
  const reviewed = reviewGoalAction(
    action_id,
    "User marked this handled from the goal screen. Verify against telemetry on a later check; re-escalate if it is still broken.",
  );
  if (!reviewed) return { ok: false, error: "Already closed." };
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Manual "Run tick now". Fire-and-forget for the turn itself, but the
 * check row is claimed synchronously inside runGoalTick's pre-await
 * prefix, so the Checks list shows the new (running, manual) check the
 * moment this action returns.
 */
export async function runTickNowAction(goal_id: string): Promise<GoalActionResult> {
  const goal = getGoal(goal_id);
  if (!goal) return { ok: false, error: "Goal not found." };
  if (goal.status !== "active") {
    return { ok: false, error: `Goal is ${goal.status} — only active goals tick.` };
  }
  void runGoalTick(goal, "manual").catch((err) =>
    console.error("[goal-tick] manual tick failed:", err),
  );
  revalidatePath("/", "layout");
  return { ok: true };
}

/** The live goal for an agent, if any (server helper for pages). */
export async function getAgentGoalAction(agent_id: string) {
  return getGoalForAgent(agent_id);
}

/**
 * Diary page for the goal screen's Checks list — checks strictly older
 * than `beforeTick` (omit for the newest page), newest first. Cursor
 * pagination (not offset) so rows never shift under the reader when a
 * new check lands mid-scroll. `filter: "action"` keeps only checks that
 * recorded an action or registered a PR.
 */
export async function loadMoreGoalChecksAction(
  goal_id: string,
  beforeTick?: number,
  filter?: CheckFilter,
): Promise<{ rows: CheckRow[]; hasMore: boolean }> {
  const goal = getGoal(goal_id);
  if (!goal) return { rows: [], hasMore: false };
  return listCheckRows(goal.id, { beforeTick, filter });
}
