import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Home,
  CheckCircle2,
  ListChecks,
  Clock,
  Plug,
  Settings,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { listProjects } from "@/server/db/projects";
import { getActiveProject } from "@/server/active-project";
import { actionableApprovalCount } from "@/server/db/approvals";
import { listProjectAgents } from "@/server/agent-meta";
import { TEMPLATES } from "@/server/agent-templates";
import { inFlightCountsByAgent } from "@/server/db/tasks";
import { projectHref } from "@/lib/project-href";
import { ProjectSwitcher } from "./project-switcher";
import { PairedOpenclawPill } from "./paired-openclaw-pill";
import { AgentNav } from "./agent-nav";
import { CreateAgentButton } from "./create-agent-button";
import { GlobalLivenessPoller } from "./global-liveness-poller";
import { Badge } from "@/components/ui/badge";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: boolean;
};

const NAV: NavItem[] = [
  { href: "", label: "Home", icon: Home },
  { href: "/approvals", label: "Approvals", icon: CheckCircle2, badge: true },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/crons", label: "Crons", icon: Clock },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/connections", label: "MCP Connections", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

export async function AppSidebar() {
  const projects = listProjects();
  const active = await getActiveProject();
  // Badge counts anything actionable: pending + revision_requested.
  const approvalsBadge = active ? actionableApprovalCount(active.slug) : 0;
  const agentEntries = active ? await listProjectAgents(active.slug) : [];
  const inFlightCounts: Record<string, number> = {};
  if (active) {
    for (const [agentId, count] of inFlightCountsByAgent(active.slug)) {
      inFlightCounts[agentId] = count;
    }
  }
  const anyInFlight = Object.values(inFlightCounts).some((n) => n > 0);

  return (
    <Sidebar collapsible="icon">
      {/* Refresh the whole layout (this sidebar + the current route's
          server components) every 5s while anything is in flight, so
          badges + task groupings stay current no matter what page the
          user is on. Self-disables when nothing is live. */}
      <GlobalLivenessPoller hasInFlight={anyInFlight} />
      <SidebarHeader>
        {/* Project switcher + collapse toggle. Toggle stays visible in
            icon-collapsed mode so the user can always re-expand the rail. */}
        <div className="flex items-center gap-1">
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
          <SidebarTrigger className="shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {active && (
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center justify-between">
              <span>Agents</span>
              <CreateAgentButton projectSlug={active.slug} />
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <AgentNav
                projectSlug={active.slug}
                agents={agentEntries.map((a) => ({
                  key: a.agent_id,
                  slug: a.slug,
                  name: a.name,
                  role_label: a.template_key
                    ? TEMPLATES.find((t) => t.key === a.template_key)?.display_name
                    : undefined,
                  description: a.description,
                  template_key: a.template_key,
                }))}
                inFlightCounts={inFlightCounts}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {active && (
          <SidebarGroup>
            <SidebarGroupLabel>Project</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.href || "home"}>
                    <SidebarMenuButton asChild>
                      <Link href={projectHref(active.slug, item.href)}>
                        <item.icon />
                        <span>{item.label}</span>
                        {item.badge && approvalsBadge > 0 && (
                          <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px]">
                            {approvalsBadge}
                          </Badge>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <div className="px-2 py-1.5">
          <PairedOpenclawPill />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
