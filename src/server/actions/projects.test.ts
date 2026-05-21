import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const redirectMock = vi.fn((_target: string) => {
  // Mimic Next.js: redirect() throws an internal signal so callers stop.
  throw new Error("NEXT_REDIRECT");
});
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...(args as [string])),
}));

const cookieGetMock = vi.fn();
const cookieSetMock = vi.fn();
const cookieDeleteMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (...args: unknown[]) => cookieGetMock(...args),
    set: (...args: unknown[]) => cookieSetMock(...args),
    delete: (...args: unknown[]) => cookieDeleteMock(...args),
  }),
}));

const archiveProjectMock = vi.fn();
const changeProjectSlugMock = vi.fn();
const createProjectMock = vi.fn();
const deleteProjectRowMock = vi.fn();
const getProjectMock = vi.fn();
const renameProjectMock = vi.fn();
vi.mock("@/server/db/projects", () => ({
  archiveProject: (...args: unknown[]) => archiveProjectMock(...args),
  changeProjectSlug: (...args: unknown[]) => changeProjectSlugMock(...args),
  createProject: (...args: unknown[]) => createProjectMock(...args),
  deleteProjectRow: (...args: unknown[]) => deleteProjectRowMock(...args),
  getProject: (...args: unknown[]) => getProjectMock(...args),
  renameProject: (...args: unknown[]) => renameProjectMock(...args),
}));

const clearActiveProjectMock = vi.fn();
const setActiveProjectMock = vi.fn();
vi.mock("@/server/active-project", () => ({
  clearActiveProject: (...args: unknown[]) => clearActiveProjectMock(...args),
  setActiveProject: (...args: unknown[]) => setActiveProjectMock(...args),
}));

const ensureProjectAgentsMock = vi.fn();
vi.mock("@/server/agent-templates", () => ({
  ensureProjectAgents: (...args: unknown[]) => ensureProjectAgentsMock(...args),
  // The onboarding scope constant. createProjectAction +
  // createProjectForOnboardingAction read it from agent-templates; the
  // reprovisionAgentsAction also passes it explicitly.
  DEFAULT_ONBOARDING_TEMPLATE_KEYS: ["cmo", "google_ads"],
  // createProjectForOnboardingAction now mints the onboarding task
  // synchronously, so it imports agentNameFor to derive the CMO id.
  agentNameFor: (slug: string, key: string, name: string) =>
    `${slug}-${key.replace(/_/g, "-")}-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`,
}));

// Same flow needs cmo-task-brief + tasks + run-task. Stub them all.
vi.mock("@/server/onboarding/cmo-task-brief", () => ({
  buildProjectOnboardingBrief: () => ({
    title: "Learn the project and write PROJECT.md",
    brief: "stub brief",
    success_criteria: "stub criteria",
  }),
}));
vi.mock("@/server/db/tasks", () => ({
  createTask: vi.fn(() => ({
    id: "onb-uuid",
    display_id: "acme-1",
    project_slug: "acme",
    agent_id: "acme-cmo-greg",
    title: "Learn the project and write PROJECT.md",
    status: "proposed",
  })),
}));
vi.mock("@/server/orchestration/run-task", () => ({
  startTaskIfProposed: vi.fn((t: unknown) => t),
}));

const startProvisioningMock = vi.fn();
const clearProvisioningMock = vi.fn();
vi.mock("@/server/onboarding/provisioning-state", () => ({
  startProvisioning: (...args: unknown[]) => startProvisioningMock(...args),
  clearProvisioning: (...args: unknown[]) => clearProvisioningMock(...args),
}));

const listProjectAgentsMock = vi.fn();
const readAgentMetaMock = vi.fn();
vi.mock("@/server/agent-meta", () => ({
  listProjectAgents: (...args: unknown[]) => listProjectAgentsMock(...args),
  readAgentMeta: (...args: unknown[]) => readAgentMetaMock(...args),
}));

const cascadeDeleteAgentMock = vi.fn();
const relocateAgentMock = vi.fn();
vi.mock("@/server/actions/agents", () => ({
  cascadeDeleteAgent: (...args: unknown[]) => cascadeDeleteAgentMock(...args),
  relocateAgent: (...args: unknown[]) => relocateAgentMock(...args),
}));

const listCronsForProjectMock = vi.fn();
const disableCronMock = vi.fn();
vi.mock("@/server/openclaw/crons", () => ({
  listCronsForProject: (...args: unknown[]) => listCronsForProjectMock(...args),
  disableCron: (...args: unknown[]) => disableCronMock(...args),
}));

const logAgentActionMock = vi.fn();
vi.mock("@/server/db/agent-actions", () => ({
  logAgentAction: (...args: unknown[]) => logAgentActionMock(...args),
}));

const getProjectDeletionSummaryMock = vi.fn();
vi.mock("@/server/openclaw/project-delete", () => ({
  getProjectDeletionSummary: (...args: unknown[]) =>
    getProjectDeletionSummaryMock(...args),
}));

const disconnectMcpMock = vi.fn();
vi.mock("@/server/mcp-state", () => ({
  disconnectMcp: (...args: unknown[]) => disconnectMcpMock(...args),
}));

// mcp-catalog: keep real implementation so storedMcpKey works.

import {
  archiveProjectAction,
  createProjectAction,
  createProjectForOnboardingAction,
  deleteProjectAction,
  getProjectDeletionSummaryAction,
  renameProjectAction,
  renameProjectFullAction,
  reprovisionAgentsAction,
  switchProjectAction,
} from "./projects";

function project(overrides: Partial<{ slug: string; display_name: string }> = {}) {
  return {
    id: "uuid",
    slug: "acme",
    display_name: "Acme",
    created_at: "now",
    archived_at: null,
    google_ads_account_id: null,
    ...overrides,
  };
}

function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.append(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureProjectAgentsMock.mockResolvedValue({
    created: ["acme-cmo"],
    existed: [],
    failed: [],
  });
});

describe("createProjectAction", () => {
  it("throws when display_name is empty", async () => {
    await expect(createProjectAction(fd({ display_name: "  " }))).rejects.toThrow(
      /Please enter a project name/,
    );
  });

  it("throws when createProject returns !ok", async () => {
    createProjectMock.mockReturnValueOnce({ ok: false, reason: "slug reserved" });
    await expect(createProjectAction(fd({ display_name: "api" }))).rejects.toThrow(
      /slug reserved/,
    );
  });

  it("redirects to / on success and triggers async provisioning", async () => {
    createProjectMock.mockReturnValueOnce({ ok: true, project: project() });
    await expect(
      createProjectAction(fd({ display_name: "Acme" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(ensureProjectAgentsMock).toHaveBeenCalledWith("acme", ["cmo", "google_ads"]);
    expect(startProvisioningMock).toHaveBeenCalled();
    expect(setActiveProjectMock).toHaveBeenCalledWith("acme");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("logs project_created after provisioning resolves", async () => {
    createProjectMock.mockReturnValueOnce({ ok: true, project: project() });
    ensureProjectAgentsMock.mockResolvedValueOnce({
      created: ["acme-cmo", "acme-google-ads"],
      existed: [],
      failed: [],
    });
    await createProjectAction(fd({ display_name: "Acme" })).catch(() => {});
    // Wait for any microtask-queued .then() to drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(logAgentActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_slug: "acme",
        agent_id: "system",
        action_type: "project_created",
      }),
    );
  });

  it("provisioning rejection is swallowed (console.error)", async () => {
    createProjectMock.mockReturnValueOnce({ ok: true, project: project() });
    ensureProjectAgentsMock.mockRejectedValueOnce(new Error("rpc down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await createProjectAction(fd({ display_name: "Acme" })).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("createProjectForOnboardingAction", () => {
  it("returns error result when display_name blank", async () => {
    const r = await createProjectForOnboardingAction(fd({ display_name: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Please enter a project name/);
  });

  it("returns error result when createProject fails", async () => {
    createProjectMock.mockReturnValueOnce({ ok: false, reason: "slug taken" });
    const r = await createProjectForOnboardingAction(fd({ display_name: "X" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/slug taken/);
  });

  it("returns slug + display_name on success without redirecting", async () => {
    createProjectMock.mockReturnValueOnce({ ok: true, project: project() });
    const r = await createProjectForOnboardingAction(
      fd({ display_name: "Acme" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ slug: "acme", display_name: "Acme" });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(startProvisioningMock).toHaveBeenCalled();
  });
});

describe("reprovisionAgentsAction", () => {
  it("returns ok+result on success and revalidates", async () => {
    ensureProjectAgentsMock.mockResolvedValueOnce({
      created: ["a"],
      existed: ["b"],
      failed: [],
    });
    const r = await reprovisionAgentsAction("acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toEqual(["a"]);
    expect(r.existed).toEqual(["b"]);
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("returns error on rejection", async () => {
    ensureProjectAgentsMock.mockRejectedValueOnce(new Error("boom"));
    const r = await reprovisionAgentsAction("acme");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/boom/);
  });
});

describe("switchProjectAction", () => {
  it("sets active project + revalidates", async () => {
    const r = await switchProjectAction("acme");
    expect(r.ok).toBe(true);
    expect(setActiveProjectMock).toHaveBeenCalledWith("acme");
    expect(revalidatePathMock).toHaveBeenCalled();
  });
});

describe("archiveProjectAction", () => {
  it("returns error when archiveProject returns null", async () => {
    archiveProjectMock.mockReturnValueOnce(null);
    const r = await archiveProjectAction("missing");
    expect(r.ok).toBe(false);
  });

  it("halts every enabled cron and counts disabled successes", async () => {
    archiveProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({
      groups: [
        {
          agent: "acme-foo",
          crons: [
            { id: "c1", disabled: false },
            { id: "c2", disabled: true },
            { id: "c3", disabled: false },
          ],
        },
      ],
    });
    disableCronMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const r = await archiveProjectAction("acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.halted_crons).toBe(2);
    expect(disableCronMock).toHaveBeenCalledTimes(2);
    expect(logAgentActionMock).toHaveBeenCalled();
  });

  it("tolerates listCronsForProject failure (no crons halted)", async () => {
    archiveProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockRejectedValueOnce(new Error("cron down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await archiveProjectAction("acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.halted_crons).toBe(0);
    spy.mockRestore();
  });

  it("tolerates individual disable failures and counts the rest", async () => {
    archiveProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({
      groups: [
        {
          agent: "acme-foo",
          crons: [
            { id: "c1", disabled: false },
            { id: "c2", disabled: false },
          ],
        },
      ],
    });
    disableCronMock
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(undefined);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await archiveProjectAction("acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.halted_crons).toBe(1);
    spy.mockRestore();
  });
});

describe("renameProjectAction", () => {
  it("returns error when renameProject returns null", async () => {
    renameProjectMock.mockReturnValueOnce(null);
    const r = await renameProjectAction("acme", "");
    expect(r.ok).toBe(false);
  });

  it("returns ok + revalidates on success", async () => {
    renameProjectMock.mockReturnValueOnce(project({ display_name: "Renamed" }));
    const r = await renameProjectAction("acme", "Renamed");
    expect(r.ok).toBe(true);
    expect(revalidatePathMock).toHaveBeenCalled();
  });
});

describe("renameProjectFullAction", () => {
  it("rejects when project not found", async () => {
    getProjectMock.mockReturnValueOnce(null);
    const r = await renameProjectFullAction({
      current_slug: "missing",
      new_display_name: "X",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not found/);
  });

  it("rejects empty new display_name", async () => {
    getProjectMock.mockReturnValueOnce(project());
    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "   ",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/empty/);
  });

  it("rejects when slugify fails", async () => {
    getProjectMock.mockReturnValueOnce(project());
    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "@@@",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Invalid name/);
  });

  it("no-op when slug+display name are unchanged", async () => {
    getProjectMock.mockReturnValueOnce(project({ display_name: "Acme" }));
    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "Acme",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.full_rename).toBe(false);
    expect(renameProjectMock).not.toHaveBeenCalled();
  });

  it("display-name-only path when slug stays the same", async () => {
    getProjectMock.mockReturnValueOnce(project({ display_name: "Acme" }));
    // "ACME!" → "acme"
    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "ACME!",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.full_rename).toBe(false);
    expect(r.data.display_name).toBe("ACME!");
    expect(renameProjectMock).toHaveBeenCalledWith("acme", "ACME!");
  });

  it("rejects when destination slug exists", async () => {
    getProjectMock
      .mockReturnValueOnce(project())
      .mockReturnValueOnce(project({ slug: "newslug" }));
    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "Newslug",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already exists/);
  });

  it("full rename relocates each agent and migrates DB rows + repoints cookie", async () => {
    getProjectMock
      .mockReturnValueOnce(project()) // current lookup
      .mockReturnValueOnce(null); // destination uniqueness check
    listProjectAgentsMock.mockResolvedValueOnce([
      {
        agent_id: "acme-cmo",
        slug: "cmo",
        display_name: "CMO",
        template_key: "cmo",
        is_template_default: true,
      },
    ]);
    readAgentMetaMock.mockReturnValueOnce({
      agent_id: "acme-cmo",
      project_slug: "acme",
      slug: "cmo",
      display_name: "CMO",
      created_at: "now",
      source_agent_id: "src",
    });
    relocateAgentMock.mockResolvedValueOnce({
      new_agent_id: "newslug-cmo",
      new_slug: "cmo",
    });
    changeProjectSlugMock.mockReturnValueOnce(undefined);
    cookieGetMock.mockReturnValueOnce({ value: "acme" });

    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "Newslug",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.full_rename).toBe(true);
    expect(r.data.slug).toBe("newslug");
    expect(r.data.agents_relocated).toEqual(["acme-cmo"]);
    expect(r.data.agents_failed).toEqual([]);
    expect(changeProjectSlugMock).toHaveBeenCalledWith("acme", "newslug", "Newslug");
    expect(setActiveProjectMock).toHaveBeenCalledWith("newslug");
  });

  it("does NOT repoint cookie when it wasn't pointing at this project", async () => {
    getProjectMock.mockReturnValueOnce(project()).mockReturnValueOnce(null);
    listProjectAgentsMock.mockResolvedValueOnce([]);
    changeProjectSlugMock.mockReturnValueOnce(undefined);
    cookieGetMock.mockReturnValueOnce({ value: "other" });

    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "Newslug",
    });
    expect(r.ok).toBe(true);
    expect(setActiveProjectMock).not.toHaveBeenCalled();
  });

  it("collects per-agent failures rather than aborting", async () => {
    getProjectMock.mockReturnValueOnce(project()).mockReturnValueOnce(null);
    listProjectAgentsMock.mockResolvedValueOnce([
      {
        agent_id: "acme-cmo",
        slug: "cmo",
        display_name: "CMO",
        is_template_default: true,
      },
      {
        agent_id: "acme-ga",
        slug: "ga",
        display_name: "GA",
        is_template_default: true,
      },
    ]);
    readAgentMetaMock.mockReturnValue(null);
    relocateAgentMock
      .mockResolvedValueOnce({ new_agent_id: "newslug-cmo", new_slug: "cmo" })
      .mockRejectedValueOnce(new Error("relocate failed"));
    changeProjectSlugMock.mockReturnValueOnce(undefined);
    cookieGetMock.mockReturnValueOnce(undefined);

    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "Newslug",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agents_relocated).toEqual(["acme-cmo"]);
    expect(r.data.agents_failed).toEqual([
      { agent_id: "acme-ga", error: "relocate failed" },
    ]);
  });

  it("surfaces changeProjectSlug failure with cleanup-needed messaging", async () => {
    getProjectMock.mockReturnValueOnce(project()).mockReturnValueOnce(null);
    listProjectAgentsMock.mockResolvedValueOnce([]);
    changeProjectSlugMock.mockImplementationOnce(() => {
      throw new Error("FK violation");
    });
    const r = await renameProjectFullAction({
      current_slug: "acme",
      new_display_name: "Newslug",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/DB migration failed/);
    expect(r.error).toMatch(/FK violation/);
  });
});

describe("getProjectDeletionSummaryAction", () => {
  it("rejects when project not found", async () => {
    getProjectMock.mockReturnValueOnce(null);
    const r = await getProjectDeletionSummaryAction("missing");
    expect(r.ok).toBe(false);
  });

  it("returns the summary on success", async () => {
    getProjectMock.mockReturnValueOnce(project());
    getProjectDeletionSummaryMock.mockResolvedValueOnce({
      project_slug: "acme",
      agents: [],
      mcps: [],
      totals: { agents: 0, threads: 0, crons: 0, mcps: 0 },
    });
    const r = await getProjectDeletionSummaryAction("acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.project_slug).toBe("acme");
  });

  it("surfaces summary errors", async () => {
    getProjectMock.mockReturnValueOnce(project());
    getProjectDeletionSummaryMock.mockRejectedValueOnce(new Error("inventory failed"));
    const r = await getProjectDeletionSummaryAction("acme");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/inventory failed/);
  });
});

describe("deleteProjectAction", () => {
  it("rejects when confirmation slug mismatches", async () => {
    const r = await deleteProjectAction("acme", "other");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Confirmation slug/);
  });

  it("rejects when project not found", async () => {
    getProjectMock.mockReturnValueOnce(null);
    const r = await deleteProjectAction("acme", "acme");
    expect(r.ok).toBe(false);
  });

  it("cascades agents, mcps, db row, clears cookie when active", async () => {
    getProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({
      groups: [
        {
          agent: "acme-cmo",
          crons: [
            { id: "c1", agent_id: "acme-cmo" },
            { id: "c2", agent_id: "acme-cmo" },
          ],
        },
      ],
    });
    listProjectAgentsMock.mockResolvedValueOnce([
      { agent_id: "acme-cmo", slug: "cmo", display_name: "CMO", is_template_default: true },
    ]);
    cascadeDeleteAgentMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      crons_removed: 2,
      crons_failed: 0,
      openclaw_deleted: true,
      meta_removed: true,
    });
    disconnectMcpMock.mockResolvedValueOnce(undefined);
    cookieGetMock.mockReturnValueOnce({ value: "acme" });

    const r = await deleteProjectAction("acme", "acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agents).toEqual(["acme-cmo"]);
    expect(r.data.agentsFailed).toEqual([]);
    expect(r.data.crons).toBe(2);
    expect(r.data.mcps).toBe(1);
    expect(deleteProjectRowMock).toHaveBeenCalledWith("acme");
    expect(clearProvisioningMock).toHaveBeenCalledWith("acme");
    expect(clearActiveProjectMock).toHaveBeenCalled();
    expect(cascadeDeleteAgentMock).toHaveBeenCalledWith({
      agent_id: "acme-cmo",
      cronIds: ["c1", "c2"],
    });
  });

  it("does NOT clear active-project cookie when it points elsewhere", async () => {
    getProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({ groups: [] });
    listProjectAgentsMock.mockResolvedValueOnce([]);
    disconnectMcpMock.mockResolvedValueOnce(undefined);
    cookieGetMock.mockReturnValueOnce({ value: "other" });
    const r = await deleteProjectAction("acme", "acme");
    expect(r.ok).toBe(true);
    expect(clearActiveProjectMock).not.toHaveBeenCalled();
  });

  it("collects failed agents into agentsFailed and continues", async () => {
    getProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({ groups: [] });
    listProjectAgentsMock.mockResolvedValueOnce([
      { agent_id: "acme-cmo", slug: "cmo", display_name: "CMO", is_template_default: true },
      { agent_id: "acme-ga", slug: "ga", display_name: "GA", is_template_default: true },
    ]);
    cascadeDeleteAgentMock
      .mockResolvedValueOnce({
        agent_id: "acme-cmo",
        crons_removed: 0,
        crons_failed: 0,
        openclaw_deleted: true,
        meta_removed: true,
      })
      .mockRejectedValueOnce(new Error("delete exploded"));
    disconnectMcpMock.mockResolvedValueOnce(undefined);
    cookieGetMock.mockReturnValueOnce(undefined);

    const r = await deleteProjectAction("acme", "acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agents).toEqual(["acme-cmo"]);
    expect(r.data.agentsFailed).toEqual([
      { agentId: "acme-ga", error: "delete exploded" },
    ]);
  });

  it("counts MCP disconnect failures into mcpsFailed", async () => {
    getProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({ groups: [] });
    listProjectAgentsMock.mockResolvedValueOnce([]);
    disconnectMcpMock.mockRejectedValueOnce(new Error("can't reach openclaw"));
    cookieGetMock.mockReturnValueOnce(undefined);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await deleteProjectAction("acme", "acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.mcps).toBe(0);
    expect(r.data.mcpsFailed).toBe(1);
    spy.mockRestore();
  });

  it("continues when listCronsForProject fails (cronsByAgent empty)", async () => {
    getProjectMock.mockReturnValueOnce(project());
    listCronsForProjectMock.mockRejectedValueOnce(new Error("cron service down"));
    listProjectAgentsMock.mockResolvedValueOnce([
      { agent_id: "acme-cmo", slug: "cmo", display_name: "CMO", is_template_default: true },
    ]);
    cascadeDeleteAgentMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      crons_removed: 0,
      crons_failed: 0,
      openclaw_deleted: true,
      meta_removed: true,
    });
    disconnectMcpMock.mockResolvedValueOnce(undefined);
    cookieGetMock.mockReturnValueOnce(undefined);
    const r = await deleteProjectAction("acme", "acme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cascadeDeleteAgentMock).toHaveBeenCalledWith({
      agent_id: "acme-cmo",
      cronIds: [],
    });
  });
});
