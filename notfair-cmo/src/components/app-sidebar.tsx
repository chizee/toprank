import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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
import { listProjectAgents } from "@/server/agent-meta";
import { TEMPLATES } from "@/server/agent-templates";
import { projectHref } from "@/lib/project-href";
import { ProjectSwitcher } from "./project-switcher";
import { AgentNav } from "./agent-nav";
import { ApprovalsLiveBadge } from "./live-badge";

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
  const agentEntries = active ? await listProjectAgents(active.slug) : [];
  // In-flight counts + approvals badge are no longer computed here.
  // LiveCountsProvider (mounted at layout level) polls
  // /api/in-flight-counts client-side and pushes fresh numbers through
  // context. Sidebar's server-rendered structure stays stable so no
  // reconciliation thrash on every poll — only the badge nodes flip.

  return (
    <Sidebar collapsible="icon">
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
            <SidebarGroupLabel>Agents</SidebarGroupLabel>
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
              />
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
                        {item.badge && <ApprovalsLiveBadge />}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

    </Sidebar>
  );
}
