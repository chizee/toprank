import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const getActiveProjectMock = vi.fn();
vi.mock("@/server/active-project", () => ({
  getActiveProject: (...args: unknown[]) => getActiveProjectMock(...args),
}));

const disableCronMock = vi.fn();
const listCronsForProjectMock = vi.fn();
const removeCronMock = vi.fn();
vi.mock("@/server/openclaw/crons", () => ({
  disableCron: (...args: unknown[]) => disableCronMock(...args),
  listCronsForProject: (...args: unknown[]) => listCronsForProjectMock(...args),
  removeCron: (...args: unknown[]) => removeCronMock(...args),
}));

const createAgentViaRpcMock = vi.fn();
const deleteAgentMock = vi.fn();
const listAllAgentsMock = vi.fn();
vi.mock("@/server/openclaw/gateway-rpc", () => ({
  createAgentViaRpc: (...args: unknown[]) => createAgentViaRpcMock(...args),
  deleteAgent: (...args: unknown[]) => deleteAgentMock(...args),
  listAllAgents: (...args: unknown[]) => listAllAgentsMock(...args),
}));

const agentExistsInProjectMock = vi.fn();
const cloneAgentMock = vi.fn();
vi.mock("@/server/openclaw/clone-agent", () => ({
  agentExistsInProject: (...args: unknown[]) => agentExistsInProjectMock(...args),
  cloneAgent: (...args: unknown[]) => cloneAgentMock(...args),
}));

const readAgentMetaMock = vi.fn();
const writeAgentMetaMock = vi.fn();
const workspaceDirForMock = vi.fn();
const listProjectAgentsMock = vi.fn();
vi.mock("@/server/agent-meta", () => ({
  readAgentMeta: (...args: unknown[]) => readAgentMetaMock(...args),
  writeAgentMeta: (...args: unknown[]) => writeAgentMetaMock(...args),
  workspaceDirFor: (...args: unknown[]) => workspaceDirForMock(...args),
  listProjectAgents: (...args: unknown[]) => listProjectAgentsMock(...args),
}));

const listSessionsForAgentMock = vi.fn();
vi.mock("@/server/openclaw/sessions", () => ({
  listSessionsForAgent: (...args: unknown[]) => listSessionsForAgentMock(...args),
}));

const existsSyncMock = vi.fn();
const rmMock = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...args: unknown[]) => rmMock(...args),
  };
});

import {
  cascadeDeleteAgent,
  cloneAgentAction,
  createAgentAction,
  deleteAgentCascadeAction,
  disableCronsAction,
  getAgentDeletionSummaryAction,
  listOpenClawAgentsAction,
  listProjectAgentsAction,
  relocateAgent,
  removeCronsAction,
  renameAgentAction,
} from "./agents";

function project(slug = "acme") {
  return {
    id: "uuid",
    slug,
    display_name: "Acme",
    created_at: "now",
    archived_at: null,
    google_ads_account_id: null,
  };
}

beforeEach(() => {
  revalidatePathMock.mockReset();
  getActiveProjectMock.mockReset();
  disableCronMock.mockReset();
  listCronsForProjectMock.mockReset();
  removeCronMock.mockReset();
  createAgentViaRpcMock.mockReset();
  deleteAgentMock.mockReset();
  listAllAgentsMock.mockReset();
  agentExistsInProjectMock.mockReset();
  cloneAgentMock.mockReset();
  readAgentMetaMock.mockReset();
  writeAgentMetaMock.mockReset();
  workspaceDirForMock.mockReset();
  listProjectAgentsMock.mockReset();
  listSessionsForAgentMock.mockReset();
  existsSyncMock.mockReset();
  rmMock.mockReset();

  workspaceDirForMock.mockImplementation((id: string) => `/ws/${id}`);
});

describe("listOpenClawAgentsAction", () => {
  it("merges openclaw list with project agent ids and marks membership", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    listProjectAgentsMock.mockResolvedValueOnce([
      { agent_id: "acme-cmo", slug: "cmo-greg", name: "Greg", template_key: "cmo", is_template_default: true },
    ]);
    listAllAgentsMock.mockResolvedValueOnce({
      agents: [
        { id: "acme-cmo", name: "fallback", identity: { name: "CMO" } },
        { id: "other-agent", name: "Other Agent" },
      ],
    });
    const r = await listOpenClawAgentsAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(2);
    const cmo = r.data.find((a) => a.agent_id === "acme-cmo")!;
    expect(cmo.in_current_project).toBe(true);
    expect(cmo.display_name).toBe("CMO");
    const other = r.data.find((a) => a.agent_id === "other-agent")!;
    expect(other.in_current_project).toBe(false);
    expect(other.display_name).toBe("Other Agent");
  });

  it("falls back to id when no identity name or name present", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    listAllAgentsMock.mockResolvedValueOnce({
      agents: [{ id: "raw-id" }],
    });
    const r = await listOpenClawAgentsAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]!.display_name).toBe("raw-id");
    expect(r.data[0]!.in_current_project).toBe(false);
  });

  it("returns error result when listAllAgents throws", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    listAllAgentsMock.mockRejectedValueOnce(new Error("gateway down"));
    const r = await listOpenClawAgentsAction();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/gateway down/);
  });

  it("returns error result with stringified non-Error", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    listAllAgentsMock.mockRejectedValueOnce("boom");
    const r = await listOpenClawAgentsAction();
    expect(r.ok).toBe(false);
  });
});

describe("listProjectAgentsAction", () => {
  it("returns error when no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const r = await listProjectAgentsAction();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No active project/);
  });

  it("returns project agents on happy path", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    listProjectAgentsMock.mockResolvedValueOnce([
      { agent_id: "acme-cmo", slug: "cmo-greg", name: "Greg", template_key: "cmo", is_template_default: true },
    ]);
    const r = await listProjectAgentsAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
  });

  it("returns error when listProjectAgents throws", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    listProjectAgentsMock.mockRejectedValueOnce(new Error("disk fail"));
    const r = await listProjectAgentsAction();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/disk fail/);
  });
});

describe("createAgentAction", () => {
  it("rejects when no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const r = await createAgentAction({ display_name: "Foo" });
    expect(r.ok).toBe(false);
  });

  it("rejects when display_name is empty (slugify fails)", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    const r = await createAgentAction({ display_name: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Invalid name/);
  });

  it("rejects when an agent with the same slug already exists in the project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    agentExistsInProjectMock.mockReturnValueOnce(true);
    const r = await createAgentAction({ display_name: "Supa" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already exists/);
  });

  it("creates the agent, writes meta, revalidates layout on success", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    agentExistsInProjectMock.mockReturnValueOnce(false);
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);
    writeAgentMetaMock.mockResolvedValueOnce(undefined);
    const r = await createAgentAction({ display_name: "Supa Agent" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agent_id).toBe("acme-supa-agent");
    expect(r.data.slug).toBe("supa-agent");
    expect(createAgentViaRpcMock).toHaveBeenCalledWith({
      name: "acme-supa-agent",
      workspace: "/ws/acme-supa-agent",
    });
    expect(writeAgentMetaMock).toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("returns error when createAgentViaRpc throws", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    agentExistsInProjectMock.mockReturnValueOnce(false);
    createAgentViaRpcMock.mockRejectedValueOnce(new Error("rpc failed"));
    const r = await createAgentAction({ display_name: "Supa" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rpc failed/);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("cloneAgentAction", () => {
  it("rejects when no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const r = await cloneAgentAction({
      source_agent_id: "acme-cmo",
      new_display_name: "Clone",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when both new_display_name and new_slug are empty/whitespace", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    const r = await cloneAgentAction({
      source_agent_id: "acme-cmo",
      new_display_name: "   ",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/provide a name/);
  });

  it("calls cloneAgent with overridden new_slug and revalidates", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    cloneAgentMock.mockResolvedValueOnce({
      new_agent_id: "acme-shortie",
      new_slug: "shortie",
      files_copied: 1,
      sessions_copied: 0,
      source_crons: [],
      new_cron_ids: [],
    });
    const r = await cloneAgentAction({
      source_agent_id: "acme-cmo",
      new_display_name: "Long Name",
      new_slug: "shortie",
    });
    expect(r.ok).toBe(true);
    expect(cloneAgentMock).toHaveBeenCalledWith({
      source_agent_id: "acme-cmo",
      project_slug: "acme",
      new_slug: "shortie",
      display_name: "Long Name",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("falls back to new_display_name when new_slug is undefined", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    cloneAgentMock.mockResolvedValueOnce({
      new_agent_id: "acme-clone-name",
      new_slug: "clone-name",
      files_copied: 0,
      sessions_copied: 0,
      source_crons: [],
      new_cron_ids: [],
    });
    const r = await cloneAgentAction({
      source_agent_id: "acme-cmo",
      new_display_name: "Clone Name",
    });
    expect(r.ok).toBe(true);
    expect(cloneAgentMock).toHaveBeenCalledWith({
      source_agent_id: "acme-cmo",
      project_slug: "acme",
      new_slug: "Clone Name",
      display_name: "Clone Name",
    });
  });

  it("returns error on cloneAgent failure (no revalidate)", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    cloneAgentMock.mockRejectedValueOnce(new Error("clone exploded"));
    const r = await cloneAgentAction({
      source_agent_id: "acme-cmo",
      new_display_name: "Clone Name",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/clone exploded/);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("disableCronsAction", () => {
  it("counts each disable success/failure independently", async () => {
    disableCronMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("bad"))
      .mockResolvedValueOnce(undefined);
    const r = await disableCronsAction(["a", "b", "c"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.disabled).toBe(2);
    expect(r.data.failed).toBe(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("handles empty list without throwing", async () => {
    const r = await disableCronsAction([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ disabled: 0, failed: 0 });
  });
});

describe("removeCronsAction", () => {
  it("counts each remove success/failure independently", async () => {
    removeCronMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("bad"));
    const r = await removeCronsAction(["a", "b"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ removed: 1, failed: 1 });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });
});

describe("renameAgentAction", () => {
  // Agents are immutable per the identity refactor — the name set at
  // onboarding (or clone time) is permanent. The action exists only so
  // import sites keep typechecking; every call must refuse with a
  // clear, actionable error message.
  it("refuses with an immutability error", async () => {
    const r = await renameAgentAction({
      agent_id: "acme-foo",
      new_display_name: "Bar",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/immutable/i);
  });
});

describe("relocateAgent", () => {
  it("clones, writes meta with preserved fields, then cascade-deletes source (best-effort)", async () => {
    cloneAgentMock.mockResolvedValueOnce({
      new_agent_id: "newproj-foo",
      new_slug: "foo",
      files_copied: 0,
      sessions_copied: 0,
      source_crons: [],
      new_cron_ids: [],
    });
    writeAgentMetaMock.mockResolvedValue(undefined);
    listCronsForProjectMock.mockResolvedValue({ groups: [] });
    deleteAgentMock.mockResolvedValue(undefined);
    existsSyncMock.mockReturnValue(false);

    const r = await relocateAgent({
      old_agent_id: "oldproj-foo",
      source_project_slug: "oldproj",
      new_project_slug: "newproj",
      new_slug: "foo",
      new_display_name: "Foo",
      preserve_template_key: "google_ads",
      preserve_source_agent_id: "src-id",
      preserve_created_at: "2024-01-01T00:00:00Z",
    });
    expect(r).toEqual({ new_agent_id: "newproj-foo", new_slug: "foo" });
    // Template agents don't persist `slug` on the sidecar (it's computed
    // from template_key + name). The relocate writer is expected to omit
    // it when preserve_template_key is set.
    expect(writeAgentMetaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "newproj-foo",
        project_slug: "newproj",
        name: "Foo",
        template_key: "google_ads",
        source_agent_id: "src-id",
        created_at: "2024-01-01T00:00:00Z",
      }),
    );
  });

  it("swallows cascadeDeleteAgent failures so the relocate still resolves", async () => {
    cloneAgentMock.mockResolvedValueOnce({
      new_agent_id: "newproj-foo",
      new_slug: "foo",
      files_copied: 0,
      sessions_copied: 0,
      source_crons: [],
      new_cron_ids: [],
    });
    writeAgentMetaMock.mockResolvedValue(undefined);
    // make cascade fail by having deleteAgent throw unrelated error
    listCronsForProjectMock.mockResolvedValue({ groups: [] });
    deleteAgentMock.mockRejectedValue(new Error("opclaw broken"));
    existsSyncMock.mockReturnValue(false);

    const r = await relocateAgent({
      old_agent_id: "oldproj-foo",
      source_project_slug: "oldproj",
      new_project_slug: "newproj",
      new_slug: "foo",
      new_display_name: "Foo",
    });
    expect(r.new_agent_id).toBe("newproj-foo");
  });

  it("throws when cloneAgent fails (source is left intact)", async () => {
    cloneAgentMock.mockRejectedValueOnce(new Error("clone failed"));
    await expect(
      relocateAgent({
        old_agent_id: "oldproj-foo",
        source_project_slug: "oldproj",
        new_project_slug: "newproj",
        new_slug: "foo",
        new_display_name: "Foo",
      }),
    ).rejects.toThrow(/clone failed/);
  });

  it("uses new Date().toISOString() when no preserve_created_at is provided", async () => {
    cloneAgentMock.mockResolvedValueOnce({
      new_agent_id: "newproj-foo",
      new_slug: "foo",
      files_copied: 0,
      sessions_copied: 0,
      source_crons: [],
      new_cron_ids: [],
    });
    writeAgentMetaMock.mockResolvedValue(undefined);
    listCronsForProjectMock.mockResolvedValue({ groups: [] });
    deleteAgentMock.mockResolvedValue(undefined);
    existsSyncMock.mockReturnValue(false);

    await relocateAgent({
      old_agent_id: "oldproj-foo",
      source_project_slug: "oldproj",
      new_project_slug: "newproj",
      new_slug: "foo",
      new_display_name: "Foo",
    });
    const writeCall = writeAgentMetaMock.mock.calls[0]![0] as { created_at: string };
    expect(Date.parse(writeCall.created_at)).toBeGreaterThan(0);
  });
});

describe("getAgentDeletionSummaryAction", () => {
  it("rejects when no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const r = await getAgentDeletionSummaryAction("acme-foo");
    expect(r.ok).toBe(false);
  });

  it("returns summary with threads + crons + meta info", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    readAgentMetaMock.mockReturnValueOnce({
      agent_id: "acme-foo",
      project_slug: "acme",
      slug: "foo",
      name: "Foo Agent",
      template_key: "google_ads",
      source_agent_id: "src",
      created_at: "now",
    });
    existsSyncMock.mockReturnValue(true);
    listSessionsForAgentMock.mockReturnValueOnce([
      { sessionId: "s1", label: "T1", lastInteractionAt: 12345 },
      { sessionId: "s2", label: "T2", lastInteractionAt: 67890 },
    ]);
    listCronsForProjectMock.mockResolvedValueOnce({
      groups: [
        {
          agent: "acme-foo",
          crons: [
            { id: "c1", name: "acme/foo/job", short_name: "job", agent_id: "acme-foo", disabled: false },
            { id: "c2", name: "n2", short_name: "", agent_id: "acme-other", disabled: false },
          ],
        },
      ],
    });
    const r = await getAgentDeletionSummaryAction("acme-foo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.exists_in_openclaw).toBe(true);
    expect(r.data.threads).toHaveLength(2);
    expect(r.data.crons).toEqual([
      { id: "c1", name: "job", disabled: false },
    ]);
    expect(r.data.template_key).toBe("google_ads");
    expect(r.data.source_agent_id).toBe("src");
  });

  it("returns summary with empty crons when listCronsForProject throws", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    readAgentMetaMock.mockReturnValueOnce(null);
    existsSyncMock.mockReturnValue(false);
    listCronsForProjectMock.mockRejectedValueOnce(new Error("cron down"));
    const r = await getAgentDeletionSummaryAction("acme-foo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.crons).toEqual([]);
    expect(r.data.threads).toEqual([]);
    expect(r.data.exists_in_openclaw).toBe(false);
    // missing meta: display_name falls back to agent_id
    expect(r.data.display_name).toBe("acme-foo");
  });

  it("falls back name to agent_id when openclaw doesn't have the agent dir", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    readAgentMetaMock.mockReturnValueOnce(null);
    existsSyncMock.mockReturnValue(false);
    listCronsForProjectMock.mockResolvedValueOnce({ groups: [] });
    const r = await getAgentDeletionSummaryAction("acme-foo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // sessions never called when dir missing
    expect(listSessionsForAgentMock).not.toHaveBeenCalled();
  });
});

describe("cascadeDeleteAgent", () => {
  it("removes crons from explicit cronIds, deletes agent, cleans meta + openclaw dir", async () => {
    removeCronMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    deleteAgentMock.mockResolvedValueOnce(undefined);
    existsSyncMock.mockReturnValue(true);
    rmMock.mockResolvedValue(undefined);

    const r = await cascadeDeleteAgent({
      agent_id: "acme-foo",
      cronIds: ["c1", "c2"],
    });
    expect(r).toMatchObject({
      agent_id: "acme-foo",
      crons_removed: 2,
      crons_failed: 0,
      openclaw_deleted: true,
      meta_removed: true,
    });
    expect(listCronsForProjectMock).not.toHaveBeenCalled();
  });

  it("looks up cronIds via project when not supplied", async () => {
    listCronsForProjectMock.mockResolvedValueOnce({
      groups: [
        {
          agent: "acme-foo",
          crons: [
            { id: "c1", agent_id: "acme-foo" },
            { id: "c2", agent_id: "acme-other" },
            { id: "c3", agent_id: "acme-foo" },
          ],
        },
      ],
    });
    removeCronMock.mockResolvedValue(undefined);
    deleteAgentMock.mockResolvedValueOnce(undefined);
    existsSyncMock.mockReturnValue(false);

    const r = await cascadeDeleteAgent({
      agent_id: "acme-foo",
      projectSlug: "acme",
    });
    expect(r.crons_removed).toBe(2);
    expect(removeCronMock).toHaveBeenCalledTimes(2);
  });

  it("treats listCronsForProject failure as empty list (no crons removed)", async () => {
    listCronsForProjectMock.mockRejectedValueOnce(new Error("cron down"));
    deleteAgentMock.mockResolvedValueOnce(undefined);
    existsSyncMock.mockReturnValue(false);
    const r = await cascadeDeleteAgent({
      agent_id: "acme-foo",
      projectSlug: "acme",
    });
    expect(r.crons_removed).toBe(0);
    expect(r.crons_failed).toBe(0);
  });

  it("counts failed cron removals separately", async () => {
    removeCronMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("nope"));
    deleteAgentMock.mockResolvedValueOnce(undefined);
    existsSyncMock.mockReturnValue(false);
    const r = await cascadeDeleteAgent({
      agent_id: "acme-foo",
      cronIds: ["c1", "c2"],
    });
    expect(r.crons_removed).toBe(1);
    expect(r.crons_failed).toBe(1);
  });

  it("treats 'unknown agent' from deleteAgent as success", async () => {
    deleteAgentMock.mockRejectedValueOnce(new Error("unknown agent foo"));
    existsSyncMock.mockReturnValue(false);
    const r = await cascadeDeleteAgent({ agent_id: "acme-foo", cronIds: [] });
    expect(r.openclaw_deleted).toBe(true);
  });

  it("treats 'not found' from deleteAgent as success", async () => {
    deleteAgentMock.mockRejectedValueOnce(new Error("agent not found"));
    existsSyncMock.mockReturnValue(false);
    const r = await cascadeDeleteAgent({ agent_id: "acme-foo", cronIds: [] });
    expect(r.openclaw_deleted).toBe(true);
  });

  it("rethrows other deleteAgent errors", async () => {
    deleteAgentMock.mockRejectedValueOnce(new Error("network exploded"));
    await expect(
      cascadeDeleteAgent({ agent_id: "acme-foo", cronIds: [] }),
    ).rejects.toThrow(/network exploded/);
  });

  it("meta_removed is false when workspace dir doesn't exist", async () => {
    deleteAgentMock.mockResolvedValueOnce(undefined);
    existsSyncMock.mockReturnValue(false);
    const r = await cascadeDeleteAgent({ agent_id: "acme-foo", cronIds: [] });
    expect(r.meta_removed).toBe(false);
  });

  it("non-fatal when rm of workspace fails", async () => {
    deleteAgentMock.mockResolvedValueOnce(undefined);
    existsSyncMock.mockReturnValue(true);
    rmMock.mockRejectedValueOnce(new Error("perm denied"));
    const r = await cascadeDeleteAgent({ agent_id: "acme-foo", cronIds: [] });
    expect(r.openclaw_deleted).toBe(true);
    expect(r.meta_removed).toBe(false);
  });
});

describe("deleteAgentCascadeAction", () => {
  it("rejects when no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const r = await deleteAgentCascadeAction("acme-foo");
    expect(r.ok).toBe(false);
  });

  it("returns ok + revalidates layout on successful cascade", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({ groups: [] });
    deleteAgentMock.mockResolvedValueOnce(undefined);
    existsSyncMock.mockReturnValue(false);
    const r = await deleteAgentCascadeAction("acme-foo");
    expect(r.ok).toBe(true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("wraps cascade errors with 'OpenClaw refused' prefix", async () => {
    getActiveProjectMock.mockResolvedValueOnce(project());
    listCronsForProjectMock.mockResolvedValueOnce({ groups: [] });
    deleteAgentMock.mockRejectedValueOnce(new Error("network down"));
    const r = await deleteAgentCascadeAction("acme-foo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/OpenClaw refused/);
    expect(r.error).toMatch(/network down/);
  });
});
