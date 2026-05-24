import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { tmpHome, ORIGINAL_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  const original = process.env.OPENCLAW_HOME;
  const tmp = mkdtempSync(joinPath(tmpdir(), "notfair-cmo-project-delete-"));
  process.env.OPENCLAW_HOME = tmp;
  return { tmpHome: tmp, ORIGINAL_HOME: original };
});

// Mock all dependencies the SUT pulls in.
const listProjectAgentsMock = vi.fn();
vi.mock("@/server/agent-meta", () => ({
  listProjectAgents: (...args: unknown[]) => listProjectAgentsMock(...args),
}));

const listSessionsMock = vi.fn();
vi.mock("@/server/openclaw/sessions", () => ({
  listSessionsForAgent: (...args: unknown[]) => listSessionsMock(...args),
}));

const listCronsMock = vi.fn();
vi.mock("@/server/openclaw/crons", () => ({
  listCronsForProject: (...args: unknown[]) => listCronsMock(...args),
}));

const readMcpConfigRowMock = vi.fn();
vi.mock("@/server/mcp/rpc", () => ({
  readMcpConfigRow: (...args: unknown[]) => readMcpConfigRowMock(...args),
}));

// mcp-catalog provides MCP_CATALOG + storedMcpKey. We use the real impl
// because it's just data + a pure helper.

import { getProjectDeletionSummary } from "./project-delete";
import { MCP_CATALOG } from "@/server/mcp-catalog";

function ensureAgentDir(agentId: string): void {
  // The SUT does `existsSync(<OPENCLAW_HOME>/agents/<agentId>)` to decide
  // if `exists` is true and if it should list sessions.
  mkdirSync(join(tmpHome, "agents", agentId), { recursive: true });
  writeFileSync(join(tmpHome, "agents", agentId, "marker"), "x", "utf8");
}

beforeEach(() => {
  listProjectAgentsMock.mockReset();
  listSessionsMock.mockReset();
  listCronsMock.mockReset();
  readMcpConfigRowMock.mockReset();
});

afterAll(() => {
  if (ORIGINAL_HOME) process.env.OPENCLAW_HOME = ORIGINAL_HOME;
  else delete process.env.OPENCLAW_HOME;
});

describe("getProjectDeletionSummary", () => {
  it("returns empty totals when no agents / crons / mcps are configured", async () => {
    listProjectAgentsMock.mockResolvedValueOnce([]);
    listCronsMock.mockResolvedValueOnce({ groups: [] });
    readMcpConfigRowMock.mockResolvedValue(null);

    const summary = await getProjectDeletionSummary("empty-project");
    expect(summary.project_slug).toBe("empty-project");
    expect(summary.agents).toEqual([]);
    expect(summary.totals).toEqual({
      agents: 0,
      threads: 0,
      crons: 0,
      mcps: 0,
    });
    // mcps array is one entry per catalog spec, all marked unconfigured.
    expect(summary.mcps.length).toBe(MCP_CATALOG.length);
    expect(summary.mcps.every((m) => !m.configured)).toBe(true);
  });

  it("counts threads from listSessionsForAgent for agents that exist on disk", async () => {
    ensureAgentDir("demo-cmo");
    ensureAgentDir("demo-google-ads");

    listProjectAgentsMock.mockResolvedValueOnce([
      {
        agent_id: "demo-cmo",
        slug: "cmo-greg",
        name: "Greg",
        template_key: "cmo",
        is_template_default: true,
      },
      {
        agent_id: "demo-google-ads",
        slug: "google-ads-ana",
        name: "Ana",
        template_key: "google_ads",
        is_template_default: true,
      },
      // Agent listed in meta but not on disk — exists:false, threads:0.
      {
        agent_id: "demo-ghost",
        slug: "ghost",
        name: "Ghost",
        is_template_default: false,
      },
    ]);
    // Two threads in CMO, none in google-ads.
    listSessionsMock.mockImplementation((id: string) => {
      if (id === "demo-cmo")
        return [
          { sessionId: "s1", label: "main", sessionKey: "x", lastInteractionAt: 0, pending: false },
          { sessionId: "s2", label: "alt", sessionKey: "y", lastInteractionAt: 0, pending: false },
        ];
      return [];
    });
    listCronsMock.mockResolvedValueOnce({
      groups: [
        { agent: "cmo", crons: [{ id: "c1" }, { id: "c2" }] },
        { agent: "google-ads", crons: [{ id: "c3" }] },
      ],
    });
    readMcpConfigRowMock.mockResolvedValue(null);

    const summary = await getProjectDeletionSummary("demo");
    expect(summary.totals.agents).toBe(2); // only the two that exist on disk
    expect(summary.totals.threads).toBe(2);
    expect(summary.totals.crons).toBe(3);

    const byId = Object.fromEntries(summary.agents.map((a) => [a.agentId, a]));
    expect(byId["demo-cmo"]!.exists).toBe(true);
    expect(byId["demo-cmo"]!.threadCount).toBe(2);
    expect(byId["demo-google-ads"]!.threadCount).toBe(0);
    expect(byId["demo-ghost"]!.exists).toBe(false);
    expect(byId["demo-ghost"]!.threadCount).toBe(0);
    // listSessionsMock should not have been called for the ghost agent.
    expect(listSessionsMock).not.toHaveBeenCalledWith("demo-ghost");
  });

  it("counts MCPs as configured when readMcpConfigRow returns a truthy row", async () => {
    listProjectAgentsMock.mockResolvedValueOnce([]);
    listCronsMock.mockResolvedValueOnce({ groups: [] });
    // Configure the first catalog entry; leave the rest unconfigured.
    const firstKey = MCP_CATALOG[0]!.key;
    readMcpConfigRowMock.mockImplementation(async (stored_key: string) => {
      if (stored_key === `demo-${firstKey}`) {
        return { url: "https://x", headers: { Authorization: "Bearer y" } };
      }
      return null;
    });

    const summary = await getProjectDeletionSummary("demo");
    expect(summary.totals.mcps).toBe(1);
    const m = summary.mcps.find((x) => x.catalog_key === firstKey);
    expect(m?.configured).toBe(true);
    expect(m?.stored_key).toBe(`demo-${firstKey}`);
  });

  it("treats listCronsForProject errors as 0 crons (best-effort)", async () => {
    listProjectAgentsMock.mockResolvedValueOnce([]);
    listCronsMock.mockRejectedValueOnce(new Error("openclaw down"));
    readMcpConfigRowMock.mockResolvedValue(null);

    const summary = await getProjectDeletionSummary("demo");
    expect(summary.totals.crons).toBe(0);
  });

  it("treats readMcpConfigRow errors as unconfigured (best-effort)", async () => {
    listProjectAgentsMock.mockResolvedValueOnce([]);
    listCronsMock.mockResolvedValueOnce({ groups: [] });
    readMcpConfigRowMock.mockRejectedValue(new Error("subprocess fail"));

    const summary = await getProjectDeletionSummary("demo");
    expect(summary.totals.mcps).toBe(0);
    expect(summary.mcps.every((m) => !m.configured)).toBe(true);
  });

  it("propagates template + display fields onto the agent summary", async () => {
    ensureAgentDir("demo-cmo");
    listProjectAgentsMock.mockResolvedValueOnce([
      {
        agent_id: "demo-cmo",
        slug: "cmo-greg",
        name: "Chief Marketing Officer",
        template_key: "cmo",
        is_template_default: true,
      },
    ]);
    listSessionsMock.mockReturnValue([]);
    listCronsMock.mockResolvedValueOnce({ groups: [] });
    readMcpConfigRowMock.mockResolvedValue(null);

    const summary = await getProjectDeletionSummary("demo");
    expect(summary.agents[0]!.template).toBe("cmo");
    expect(summary.agents[0]!.display_name).toBe("Chief Marketing Officer");
  });
});
