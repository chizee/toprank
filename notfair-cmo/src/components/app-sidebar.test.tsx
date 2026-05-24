// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const listProjects = vi.fn();
const getActiveProject = vi.fn();
const actionableApprovalCount = vi.fn();
const listProjectAgents = vi.fn();
const inFlightCountsByAgent = vi.fn();
const discoverGateway = vi.fn();

vi.mock("@/server/db/projects", () => ({
  listProjects: (...args: unknown[]) => listProjects(...args),
}));

vi.mock("@/server/active-project", () => ({
  getActiveProject: (...args: unknown[]) => getActiveProject(...args),
}));

vi.mock("@/server/db/approvals", () => ({
  actionableApprovalCount: (...args: unknown[]) => actionableApprovalCount(...args),
}));

vi.mock("@/server/agent-meta", () => ({
  listProjectAgents: (...args: unknown[]) => listProjectAgents(...args),
}));

vi.mock("@/server/db/tasks", () => ({
  inFlightCountsByAgent: (...args: unknown[]) => inFlightCountsByAgent(...args),
}));

vi.mock("@/server/openclaw/gateway-client", () => ({
  discoverGateway: (...args: unknown[]) => discoverGateway(...args),
}));

vi.mock("./project-switcher", () => ({
  ProjectSwitcher: ({
    projects,
    activeSlug,
  }: {
    projects: Array<{ slug: string; display_name: string }>;
    activeSlug: string | null;
  }) => (
    <div data-testid="project-switcher">
      switcher:{activeSlug ?? "-"}/{projects.length}
    </div>
  ),
}));

vi.mock("./agent-nav", () => ({
  AgentNav: ({
    projectSlug,
    agents,
    inFlightCounts,
  }: {
    projectSlug: string;
    agents: Array<{ slug: string; display_name: string }>;
    inFlightCounts?: Record<string, number>;
  }) => (
    <div data-testid="agent-nav">
      nav:{projectSlug}:{agents.map((a) => a.slug).join(",")}:
      {JSON.stringify(inFlightCounts ?? {})}
    </div>
  ),
}));

vi.mock("./create-agent-button", () => ({
  CreateAgentButton: ({ projectSlug }: { projectSlug: string }) => (
    <button data-testid="create-agent-button">create:{projectSlug}</button>
  ),
}));

vi.mock("./global-liveness-poller", () => ({
  GlobalLivenessPoller: ({ hasInFlight }: { hasInFlight: boolean }) => (
    <div data-testid="liveness-poller">live:{String(hasInFlight)}</div>
  ),
}));

vi.mock("@/components/ui/sidebar", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Sidebar: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarGroup: Pass,
    SidebarGroupContent: Pass,
    SidebarGroupLabel: Pass,
    SidebarHeader: Pass,
    SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
    SidebarMenuButton: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
    SidebarSeparator: () => <hr />,
    SidebarTrigger: () => <button data-testid="sidebar-trigger">trigger</button>,
  };
});

import { AppSidebar } from "./app-sidebar";

const projects = [
  {
    id: "1",
    slug: "alpha",
    display_name: "Alpha",
    created_at: "",
    archived_at: null,
    google_ads_account_id: null,
  },
  {
    id: "2",
    slug: "beta",
    display_name: "Beta",
    created_at: "",
    archived_at: null,
    google_ads_account_id: null,
  },
];

beforeEach(() => {
  listProjects.mockReset();
  getActiveProject.mockReset();
  actionableApprovalCount.mockReset();
  listProjectAgents.mockReset();
  inFlightCountsByAgent.mockReset();
  discoverGateway.mockReset();
  discoverGateway.mockImplementation(() => {
    throw new Error("no gateway");
  });
});

afterEach(() => {
  cleanup();
});

async function renderSidebar() {
  const tree = await AppSidebar();
  return render(tree);
}

describe("AppSidebar", () => {
  it("renders the project switcher with the active slug", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(0);
    listProjectAgents.mockResolvedValue([]);
    inFlightCountsByAgent.mockReturnValue(new Map());
    await renderSidebar();
    expect(screen.getByTestId("project-switcher").textContent).toBe(
      "switcher:alpha/2",
    );
  });

  it("hides the agent + project nav sections when no project is active", async () => {
    listProjects.mockReturnValue([]);
    getActiveProject.mockResolvedValue(null);
    await renderSidebar();
    expect(screen.queryByTestId("agent-nav")).not.toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
    expect(screen.queryByText("Project")).not.toBeInTheDocument();
  });

  it("renders project navigation links scoped to the active slug", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(0);
    listProjectAgents.mockResolvedValue([]);
    inFlightCountsByAgent.mockReturnValue(new Map());
    await renderSidebar();
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute(
      "href",
      "/alpha",
    );
    expect(screen.getByRole("link", { name: /approvals/i })).toHaveAttribute(
      "href",
      "/alpha/approvals",
    );
    expect(screen.getByRole("link", { name: /tasks/i })).toHaveAttribute(
      "href",
      "/alpha/tasks",
    );
    expect(screen.getByRole("link", { name: /crons/i })).toHaveAttribute(
      "href",
      "/alpha/crons",
    );
    expect(screen.getByRole("link", { name: /activity/i })).toHaveAttribute(
      "href",
      "/alpha/activity",
    );
    expect(screen.getByRole("link", { name: /connections/i })).toHaveAttribute(
      "href",
      "/alpha/connections",
    );
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute(
      "href",
      "/alpha/settings",
    );
  });

  it("shows the approvals badge with the pending count when non-zero", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(7);
    listProjectAgents.mockResolvedValue([]);
    inFlightCountsByAgent.mockReturnValue(new Map());
    await renderSidebar();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("omits the badge when approvals are zero", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(0);
    listProjectAgents.mockResolvedValue([]);
    inFlightCountsByAgent.mockReturnValue(new Map());
    await renderSidebar();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("forwards agents and in-flight counts to AgentNav", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(0);
    listProjectAgents.mockResolvedValue([
      {
        agent_id: "alpha-cmo",
        slug: "cmo",
        display_name: "CMO",
        description: "",
        template_key: "cmo",
      },
    ]);
    inFlightCountsByAgent.mockReturnValue(new Map([["alpha-cmo", 2]]));
    await renderSidebar();
    const nav = screen.getByTestId("agent-nav");
    expect(nav.textContent).toContain("nav:alpha:cmo:");
    expect(nav.textContent).toContain("alpha-cmo");
    expect(nav.textContent).toContain("2");
  });

  it("flips the liveness flag on when any agent has in-flight work", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(0);
    listProjectAgents.mockResolvedValue([]);
    inFlightCountsByAgent.mockReturnValue(new Map([["alpha-cmo", 1]]));
    await renderSidebar();
    expect(screen.getByTestId("liveness-poller").textContent).toBe("live:true");
  });

  it("keeps the liveness flag off when nothing is running", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(0);
    listProjectAgents.mockResolvedValue([]);
    inFlightCountsByAgent.mockReturnValue(new Map([["alpha-cmo", 0]]));
    await renderSidebar();
    expect(screen.getByTestId("liveness-poller").textContent).toBe("live:false");
  });

  it("shows the CreateAgentButton when a project is active", async () => {
    listProjects.mockReturnValue(projects);
    getActiveProject.mockResolvedValue(projects[0]);
    actionableApprovalCount.mockReturnValue(0);
    listProjectAgents.mockResolvedValue([]);
    inFlightCountsByAgent.mockReturnValue(new Map());
    await renderSidebar();
    expect(screen.getByTestId("create-agent-button").textContent).toBe(
      "create:alpha",
    );
  });
});
