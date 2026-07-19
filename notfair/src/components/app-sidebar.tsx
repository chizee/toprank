import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { SidebarBrand } from "@/components/sidebar-brand";
import { BookOpen, FolderPlus, LayoutGrid, Plug, Plus, Settings, type LucideIcon } from "lucide-react";
import { listProjects } from "@/server/db/projects";
import { getActiveProject } from "@/server/active-project";
import { listProjectAgents } from "@/server/agent-meta";
import {
  countUserActionRequests,
  getPinnedGoalIds,
  listGoals,
  listLiveGoals,
  type GoalStatus,
} from "@/server/db/goals";
import { colorForAgentSlug } from "@/lib/agent-colors";
import { SidebarGoalItem } from "@/components/sidebar-goal-item";
import { SidebarGoalGroup } from "@/components/sidebar-goal-group";
import { GoalGroupEditor, type GoalGroupEditorGoal } from "@/components/goal-group-editor";
import { readHarnessUsage } from "@/server/harness-usage";
import { projectHref } from "@/lib/project-href";
import { goalLabel } from "@/lib/goal-label";
import { ProjectSwitcher } from "./project-switcher";
import { HarnessFooter } from "./harness-footer";
import { SidebarVersion } from "./sidebar-version";
import { ThemeToggle } from "./theme-toggle";
import { listGoalGroupMemberships, listGoalGroups } from "@/server/db/goal-groups";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const NAV: NavItem[] = [
  { href: "/context", label: "Shared context", icon: BookOpen },
  { href: "/connections", label: "Connections", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Compact status dot per live goal state — the rail's only status signal.
 *  Closed goals never render here; their outcomes live on the board. */
const GOAL_DOT: Partial<Record<GoalStatus, string>> = {
  intake: "ns-dot-warn",
  proposed: "ns-dot-warn",
  active: "ns-dot-live",
  paused: "ns-dot-mute",
};

export async function AppSidebar() {
  const projects = listProjects();
  const active = await getActiveProject();
  const agentEntries = active ? await listProjectAgents(active.slug) : [];
  // The rail shows only non-closed goals — an achieved/failed/closed goal
  // moves to the All-goals board instead of lingering in daily nav.
  // Pinned goals float to the top; the rest keep creation order.
  const liveGoals = active ? listLiveGoals(active.slug) : [];
  const pinnedIds = active ? getPinnedGoalIds(active.slug) : new Set<string>();
  const railGoals = [
    ...liveGoals.filter((g) => pinnedIds.has(g.id)),
    ...liveGoals.filter((g) => !pinnedIds.has(g.id)),
  ];
  const allGoals = active ? listGoals(active.slug) : [];
  const totalGoals = allGoals.length;
  const goalGroups = active ? listGoalGroups(active.slug) : [];
  const memberships = active ? listGoalGroupMemberships(active.slug) : [];
  const groupIdByGoal = new Map(memberships.map((membership) => [membership.goal_id, membership.group_id]));
  const ungroupedRailGoals = railGoals.filter((goal) => !groupIdByGoal.has(goal.id));
  const agentBySlug = new Map(agentEntries.map((a) => [a.agent_id, a]));
  // Move-to-group menu targets on every goal row.
  const groupTargets = goalGroups.map((group) => ({ id: group.id, name: group.name }));
  // Open "Needs you" escalations per goal — amber mark on the rail rows.
  const attentionByGoal = active ? countUserActionRequests(active.slug) : new Map<string, number>();
  // Full goal list for the create-group dialog behind the + header action.
  const groupNameById = new Map(goalGroups.map((group) => [group.id, group.name]));
  const editorGoals: GoalGroupEditorGoal[] = allGoals.map((goal) => {
    const memberOf = groupIdByGoal.get(goal.id) ?? null;
    return {
      id: goal.id,
      label: goalLabel(goal),
      status: goal.status,
      current_group_id: memberOf,
      current_group_name: memberOf ? groupNameById.get(memberOf) ?? null : null,
    };
  });
  // Best-effort fetch of harness usage. For Codex this hits the
  // chatgpt.com wham/usage endpoint (cached 60s in-process); for
  // Claude Code it just reads the local stats-cache. Either failure
  // mode collapses to a quieter chip.
  const harnessUsage = active
    ? await readHarnessUsage(active.harness_adapter)
    : null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* Brand mark + project switcher. The mark doubles as the expand
            toggle when collapsed (SidebarBrand handles both modes);
            SidebarTrigger only renders in the expanded state so the icon
            rail isn't doubled up. */}
        <div className="flex items-center gap-1">
          <SidebarBrand homeHref={active ? projectHref(active.slug, "") : "/"} />
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <SidebarMenu>
              <SidebarMenuItem>
                <ProjectSwitcher
                  projects={projects}
                  activeSlug={active?.slug ?? null}
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
          <SidebarTrigger className="shrink-0 group-data-[collapsible=icon]:hidden" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {active && (
          <SidebarGroup>
            <SidebarGroupLabel>Goals</SidebarGroupLabel>
            <GoalGroupEditor
              projectSlug={active.slug}
              goals={editorGoals}
              trigger={
                <SidebarGroupAction title="New group">
                  <FolderPlus />
                  <span className="sr-only">New group</span>
                </SidebarGroupAction>
              }
            />
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <Link href={projectHref(active.slug, "")}>
                      <Plus />
                      <span>New goal…</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {ungroupedRailGoals.map((goal) => {
                  const agent = agentBySlug.get(goal.agent_id);
                  if (!agent) return null;
                  const color = colorForAgentSlug(agent.slug);
                  return (
                    <SidebarGoalItem
                      key={goal.id}
                      href={projectHref(active.slug, `/goals/${agent.slug}`)}
                      homeHref={projectHref(active.slug, "")}
                      goalId={goal.id}
                      label={goalLabel(goal)}
                      status={goal.status as "intake" | "proposed" | "active" | "paused"}
                      pinned={pinnedIds.has(goal.id)}
                      dotClass={GOAL_DOT[goal.status] ?? "ns-dot-mute"}
                      labelClass={color.label}
                      projectSlug={active.slug}
                      groups={groupTargets}
                      groupId={null}
                      needsAttention={(attentionByGoal.get(goal.id) ?? 0) > 0}
                    />
                  );
                })}
                {goalGroups.map((group) => {
                  const groupGoals = railGoals.filter((goal) => groupIdByGoal.get(goal.id) === group.id);
                  return (
                    <SidebarGoalGroup
                      key={group.id}
                      groupId={group.id}
                      name={group.name}
                      href={projectHref(active.slug, `/groups/${group.id}`)}
                      liveCount={groupGoals.length}
                    >
                      {groupGoals.map((goal) => {
                        const agent = agentBySlug.get(goal.agent_id);
                        if (!agent) return null;
                        const color = colorForAgentSlug(agent.slug);
                        return (
                          <SidebarGoalItem
                            key={goal.id}
                            href={projectHref(active.slug, `/goals/${agent.slug}`)}
                            homeHref={projectHref(active.slug, "")}
                            goalId={goal.id}
                            label={goalLabel(goal)}
                            status={goal.status as "intake" | "proposed" | "active" | "paused"}
                            pinned={pinnedIds.has(goal.id)}
                            dotClass={GOAL_DOT[goal.status] ?? "ns-dot-mute"}
                            labelClass={color.label}
                            projectSlug={active.slug}
                            groups={groupTargets}
                            groupId={group.id}
                            needsAttention={(attentionByGoal.get(goal.id) ?? 0) > 0}
                          />
                        );
                      })}
                    </SidebarGoalGroup>
                  );
                })}
                {totalGoals > 0 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link href={projectHref(active.slug, "/goals")}>
                        <LayoutGrid />
                        <span>All goals</span>
                        <span className="ml-auto text-[11px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
                          {totalGoals}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {active && (
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.href || "home"}>
                    <SidebarMenuButton asChild>
                      <Link href={projectHref(active.slug, item.href)}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="px-3 py-2 group-data-[collapsible=icon]:hidden">
        {active && harnessUsage && (
          <HarnessFooter
            adapter={active.harness_adapter}
            usage={harnessUsage}
          />
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <SidebarVersion />
          </div>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
