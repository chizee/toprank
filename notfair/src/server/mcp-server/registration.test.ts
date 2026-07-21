import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdapter: vi.fn(),
  getProject: vi.fn(),
  listProjectAgents: vi.fn(),
  mcpSpecByKey: vi.fn(),
  findMcpToken: vi.fn(),
  getOrCreateMcpServerSecret: vi.fn(() => "shared-secret"),
  registerMcp: vi.fn(async () => {}),
}));

vi.mock("@/server/adapters/registry", () => ({
  requireAdapter: mocks.requireAdapter,
}));
vi.mock("@/server/db/projects", () => ({
  getProject: mocks.getProject,
}));
vi.mock("@/server/agent-meta", () => ({
  listProjectAgents: mocks.listProjectAgents,
}));
vi.mock("@/server/mcp-catalog", () => ({
  mcpSpecByKey: mocks.mcpSpecByKey,
}));
vi.mock("@/server/mcp/tokens", () => ({
  findMcpToken: mocks.findMcpToken,
}));
vi.mock("./secret", () => ({
  getOrCreateMcpServerSecret: mocks.getOrCreateMcpServerSecret,
}));

import {
  BROWSER_MCP_KEY,
  GOALS_MCP_KEY,
  registerBrowserMcpForAgent,
  registerCatalogMcpForAgent,
  registerCatalogMcpForProject,
  registerGoalsMcpForAgent,
} from "./registration";

const PROJECT = { slug: "proj", harness_adapter: "claude-code-local" };
const SPEC = { key: "notfair-googleads", resource_url: "https://srv/mcp" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NOTFAIR_MCP_URL;
  delete process.env.NOTFAIR_BROWSER_MCP_URL;
  delete process.env.NOTFAIR_PORT;
  mocks.getProject.mockReturnValue(PROJECT);
  mocks.requireAdapter.mockReturnValue({ registerMcp: mocks.registerMcp });
  mocks.mcpSpecByKey.mockReturnValue(SPEC);
  mocks.findMcpToken.mockReturnValue({ access_token_enc: "enc-token" });
  mocks.getOrCreateMcpServerSecret.mockReturnValue("shared-secret");
});

describe("registerGoalsMcpForAgent", () => {
  it("registers with default goals URL + bearer secret", async () => {
    const r = await registerGoalsMcpForAgent("proj", "agent-1");
    expect(r).toEqual({
      ok: true,
      key: GOALS_MCP_KEY,
      url: "http://127.0.0.1:3326/api/mcp/goals",
    });
    expect(mocks.registerMcp).toHaveBeenCalledWith({
      serverName: GOALS_MCP_KEY,
      agentId: "agent-1",
      projectSlug: "proj",
      transport: {
        type: "http",
        url: "http://127.0.0.1:3326/api/mcp/goals",
        headers: { Authorization: "Bearer shared-secret" },
      },
    });
  });

  it("honors NOTFAIR_PORT and NOTFAIR_MCP_URL overrides", async () => {
    process.env.NOTFAIR_PORT = "9999";
    let r = await registerGoalsMcpForAgent("proj", "a");
    expect(r.url).toBe("http://127.0.0.1:9999/api/mcp/goals");

    process.env.NOTFAIR_MCP_URL = "https://custom/mcp";
    r = await registerGoalsMcpForAgent("proj", "a");
    expect(r.url).toBe("https://custom/mcp");
  });

  it("fails when the project is unknown", async () => {
    mocks.getProject.mockReturnValue(null);
    const r = await registerGoalsMcpForAgent("proj", "a");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Unknown project") });
    expect(mocks.registerMcp).not.toHaveBeenCalled();
  });

  it("fails when the adapter throws", async () => {
    mocks.requireAdapter.mockImplementation(() => {
      throw new Error("no adapter");
    });
    const r = await registerGoalsMcpForAgent("proj", "a");
    expect(r).toMatchObject({ ok: false, error: "no adapter" });
  });

  it("stringifies non-Error throws from the adapter", async () => {
    mocks.requireAdapter.mockImplementation(() => {
      throw "weird";
    });
    const r = await registerGoalsMcpForAgent("proj", "a");
    expect(r).toMatchObject({ ok: false, error: "weird" });
  });
});

describe("registerBrowserMcpForAgent", () => {
  it("registers with the default browser URL", async () => {
    const r = await registerBrowserMcpForAgent("proj", "a");
    expect(r).toEqual({
      ok: true,
      key: BROWSER_MCP_KEY,
      url: "http://127.0.0.1:3326/api/mcp/browser",
    });
  });

  it("honors NOTFAIR_BROWSER_MCP_URL", async () => {
    process.env.NOTFAIR_BROWSER_MCP_URL = "https://custom/browser";
    const r = await registerBrowserMcpForAgent("proj", "a");
    expect(r.url).toBe("https://custom/browser");
  });
});

describe("registerCatalogMcpForAgent", () => {
  it("registers using the catalog resource URL + token bearer", async () => {
    const r = await registerCatalogMcpForAgent("proj", "notfair-googleads", "agent-1");
    expect(r).toEqual({ ok: true, key: "notfair-googleads", url: SPEC.resource_url });
    expect(mocks.registerMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "notfair-googleads",
        transport: expect.objectContaining({
          url: SPEC.resource_url,
          headers: { Authorization: "Bearer enc-token" },
        }),
      }),
    );
  });

  it("fails on unknown catalog key", async () => {
    mocks.mcpSpecByKey.mockReturnValue(undefined);
    const r = await registerCatalogMcpForAgent("proj", "nope", "a");
    expect(r).toMatchObject({ ok: false, url: "", error: expect.stringContaining("Unknown catalog key") });
  });

  it("fails on unknown project (with spec url echoed)", async () => {
    mocks.getProject.mockReturnValue(null);
    const r = await registerCatalogMcpForAgent("proj", "notfair-googleads", "a");
    expect(r).toMatchObject({ ok: false, url: SPEC.resource_url, error: expect.stringContaining("Unknown project") });
  });

  it("fails when no token is stored", async () => {
    mocks.findMcpToken.mockReturnValue(null);
    const r = await registerCatalogMcpForAgent("proj", "notfair-googleads", "a");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("No token stored") });
  });

  it("fails when the adapter throws", async () => {
    mocks.registerMcp.mockRejectedValueOnce(new Error("register failed"));
    const r = await registerCatalogMcpForAgent("proj", "notfair-googleads", "a");
    expect(r).toMatchObject({ ok: false, error: "register failed" });
  });

  it("stringifies non-Error throws", async () => {
    mocks.registerMcp.mockRejectedValueOnce("boom");
    const r = await registerCatalogMcpForAgent("proj", "notfair-googleads", "a");
    expect(r).toMatchObject({ ok: false, error: "boom" });
  });
});

describe("registerCatalogMcpForProject", () => {
  it("registers for each agent and collects results", async () => {
    mocks.listProjectAgents.mockResolvedValue([
      { agent_id: "a1" },
      { agent_id: "a2" },
    ]);
    const results = await registerCatalogMcpForProject("proj", "notfair-googleads");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(mocks.registerMcp).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array when the project has no agents", async () => {
    mocks.listProjectAgents.mockResolvedValue([]);
    const results = await registerCatalogMcpForProject("proj", "notfair-googleads");
    expect(results).toEqual([]);
  });
});
