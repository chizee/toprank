import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { getProject } from "@/server/db/projects";
import { listProjectAgents } from "@/server/agent-meta";
import { getPinnedGoalIds, listGoals, listMetricSnapshots } from "@/server/db/goals";
import { projectHref } from "@/lib/project-href";
import { goalLabel } from "@/lib/goal-label";
import {
  GoalsBoard,
  type BoardGoal,
  type GoalDashboardSection,
} from "@/components/goals-board";
import {
  listGoalGroupMemberships,
  listGoalGroups,
} from "@/server/db/goal-groups";
import { GoalGroupEditor, type GoalGroupEditorGoal } from "@/components/goal-group-editor";
import { GoalAutoRefresh } from "@/components/goal-auto-refresh";

export const dynamic = "force-dynamic";

/**
 * The workspace goal dashboard: every main metric and its history, arranged
 * into the same goal groups users manage in the sidebar.
 */
export default async function AllGoalsPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project: slug } = await params;
  const project = getProject(slug);
  if (!project || project.archived_at) notFound();

  const agents = await listProjectAgents(slug);
  const agentById = new Map(agents.map((a) => [a.agent_id, a]));
  const pinnedIds = getPinnedGoalIds(slug);
  const projectGoals = listGoals(slug);
  const groups = listGoalGroups(slug);
  const membershipByGoal = new Map(
    listGoalGroupMemberships(slug).map((membership) => [membership.goal_id, membership.group_id]),
  );
  const groupById = new Map(groups.map((group) => [group.id, group.name]));

  // Plain-JSON card props for the dashboard. Goals whose agent sidecar is
  // missing (half-deleted workspace) have no page to link to, so skip them.
  const goals = projectGoals.flatMap<BoardGoal>((g) => {
    const agent = agentById.get(g.agent_id);
    if (!agent) return [];
    return [
      {
        id: g.id,
        href: projectHref(slug, `/goals/${agent.slug}`),
        label: goalLabel(g),
        statement: g.statement,
        status: g.status,
        status_reason: g.status_reason,
        metric_name: g.metric_name,
        current_value: g.current_value,
        target_value: g.target_value,
        metric_direction: g.metric_direction,
        mode: g.mode,
        tick_count: g.tick_count,
        pinned: pinnedIds.has(g.id),
        updated_at: g.updated_at,
        snapshots: listMetricSnapshots(g.id, 120).map((snapshot) => snapshot.value),
      },
    ];
  });

  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const goalsByGroup = new Map<string, BoardGoal[]>();
  for (const [goalId, groupId] of membershipByGoal) {
    const goal = goalById.get(goalId);
    if (!goal) continue;
    const groupGoals = goalsByGroup.get(groupId) ?? [];
    groupGoals.push(goal);
    goalsByGroup.set(groupId, groupGoals);
  }
  const sections: GoalDashboardSection[] = groups.map((group) => ({
    id: group.id,
    href: projectHref(slug, `/groups/${group.id}`),
    name: group.name,
    description: group.description || "A shared dashboard for related goals.",
    goals: goalsByGroup.get(group.id) ?? [],
  }));
  const ungroupedGoals = goals.filter((goal) => !membershipByGoal.has(goal.id));
  if (ungroupedGoals.length > 0) {
    sections.push({
      id: "ungrouped",
      href: null,
      name: "Ungrouped",
      description: "Independent goals that are not part of a shared dashboard.",
      goals: ungroupedGoals,
    });
  }
  const editorGoals: GoalGroupEditorGoal[] = projectGoals.map((goal) => {
    const groupId = membershipByGoal.get(goal.id) ?? null;
    return {
      id: goal.id,
      label: goalLabel(goal),
      status: goal.status,
      current_group_id: groupId,
      current_group_name: groupId ? groupById.get(groupId) ?? null : null,
    };
  });

  return (
    <>
      {goals.some((goal) => goal.status === "active") && (
        <GoalAutoRefresh intervalMs={60_000} />
      )}
      <div className="absolute inset-0 overflow-y-auto">
        <main className="mx-auto w-full max-w-[1320px] px-4 pt-8 pb-20 sm:px-7">
          <header className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="ns-page-head-stack">
              <h1 className="ns-page-title">Goals dashboard</h1>
              <p className="ns-page-sub">
                Every main metric in {project.display_name}, grouped by the work it belongs to.
              </p>
            </div>
            <div className="ns-page-actions">
              <GoalGroupEditor projectSlug={slug} goals={editorGoals} />
              <Link href={projectHref(slug, "")} className="ns-btn ns-btn-ghost shrink-0">
                <Plus className="size-3.5" />
                New goal
              </Link>
            </div>
          </header>

          {goals.length === 0 ? (
            <div className="ns-card p-8 text-center">
              <p className="m-0 text-[13.5px] text-[hsl(var(--notfair-ink-3))]">
                No goals yet. State an ambition and NotFair will figure out how to
                measure and chase it.
              </p>
              <Link
                href={projectHref(slug, "")}
                className="ns-btn ns-btn-primary mt-4 inline-flex"
              >
                <Plus className="size-3.5" />
                Create your first goal
              </Link>
            </div>
          ) : (
            <GoalsBoard sections={sections} />
          )}
        </main>
      </div>
    </>
  );
}
