import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { tmpHome, tmpData, ORIGINAL_HOME, ORIGINAL_DATA } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  const origHome = process.env.OPENCLAW_HOME;
  const origData = process.env.NOTFAIR_CMO_DATA_DIR;
  const home = mkdtempSync(joinPath(tmpdir(), "notfair-cmo-clone-home-"));
  const data = mkdtempSync(joinPath(tmpdir(), "notfair-cmo-clone-data-"));
  process.env.OPENCLAW_HOME = home;
  process.env.NOTFAIR_CMO_DATA_DIR = data;
  return {
    tmpHome: home,
    tmpData: data,
    ORIGINAL_HOME: origHome,
    ORIGINAL_DATA: origData,
  };
});

// Mock openclaw CLI subprocess.
const openclawMock = vi.fn();
vi.mock("./cli", () => ({
  openclaw: (...args: unknown[]) => openclawMock(...args),
}));

// Mock gateway-rpc methods used by clone-agent.
const createAgentViaRpcMock = vi.fn();
const listAgentFilesMock = vi.fn();
const getAgentFileMock = vi.fn();
const setAgentFileMock = vi.fn();
vi.mock("./gateway-rpc", () => ({
  createAgentViaRpc: (...args: unknown[]) => createAgentViaRpcMock(...args),
  listAgentFiles: (...args: unknown[]) => listAgentFilesMock(...args),
  getAgentFile: (...args: unknown[]) => getAgentFileMock(...args),
  setAgentFile: (...args: unknown[]) => setAgentFileMock(...args),
}));

import { agentExistsInProject, cloneAgent } from "./clone-agent";

function writeSourceSessionsDir(
  sourceAgent: string,
  sessionsJson: Record<string, unknown>,
  extras: Record<string, string> = {},
): void {
  const dir = join(tmpHome, "agents", sourceAgent, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(sessionsJson), "utf8");
  for (const [name, content] of Object.entries(extras)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
}

beforeEach(() => {
  openclawMock.mockReset();
  createAgentViaRpcMock.mockReset();
  listAgentFilesMock.mockReset();
  getAgentFileMock.mockReset();
  setAgentFileMock.mockReset();
});

afterAll(() => {
  if (ORIGINAL_HOME) process.env.OPENCLAW_HOME = ORIGINAL_HOME;
  else delete process.env.OPENCLAW_HOME;
  if (ORIGINAL_DATA) process.env.NOTFAIR_CMO_DATA_DIR = ORIGINAL_DATA;
  else delete process.env.NOTFAIR_CMO_DATA_DIR;
});

describe("agentExistsInProject", () => {
  it("returns false when neither dir exists", () => {
    expect(agentExistsInProject("none", "missing")).toBe(false);
  });

  it("returns true when notfair data dir has content", () => {
    const dir = join(tmpData, "agents", "p1-foo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta"), "x", "utf8");
    expect(agentExistsInProject("p1", "foo")).toBe(true);
  });

  it("returns true when openclaw agent dir has content", () => {
    const dir = join(tmpHome, "agents", "p2-bar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker"), "x", "utf8");
    expect(agentExistsInProject("p2", "bar")).toBe(true);
  });

  it("returns false when the dir exists but is empty (deleted remnant)", () => {
    const dir = join(tmpHome, "agents", "p3-empty");
    mkdirSync(dir, { recursive: true });
    expect(agentExistsInProject("p3", "empty")).toBe(false);
  });
});

describe("cloneAgent", () => {
  it("rejects an invalid user slug", async () => {
    await expect(
      cloneAgent({
        source_agent_id: "demo-cmo",
        project_slug: "demo",
        new_slug: "###",
      }),
    ).rejects.toThrow(/Invalid agent slug/);
  });

  it("rejects an invalid canonical slug when slug_is_canonical=true", async () => {
    await expect(
      cloneAgent({
        source_agent_id: "demo-cmo",
        project_slug: "demo",
        new_slug: "BAD SLUG",
        slug_is_canonical: true,
      }),
    ).rejects.toThrow(/Invalid canonical slug/);
  });

  it("allows reserved slugs when slug_is_canonical=true (relocate path)", async () => {
    // `cmo` is reserved in slugify but allowed as a canonical slug.
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);
    listAgentFilesMock.mockRejectedValueOnce(new Error("list down")); // exercise outer catch
    // No jobs.json so loadAllCrons returns [].
    const result = await cloneAgent({
      source_agent_id: "demo-cmo",
      project_slug: "fresh-proj-1",
      new_slug: "cmo",
      slug_is_canonical: true,
    });
    expect(result.new_slug).toBe("cmo");
    expect(result.new_agent_id).toBe("fresh-proj-1-cmo");
    expect(result.files_copied).toBe(0);
    expect(result.sessions_copied).toBe(0);
    expect(result.source_crons).toEqual([]);
  });

  it("throws when an agent at the target slug already exists in the project", async () => {
    // Pre-create the notfair sidecar dir to trigger agentExistsInProject.
    const dir = join(tmpData, "agents", "collide-cmo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x"), "1", "utf8");

    await expect(
      cloneAgent({
        source_agent_id: "demo-cmo",
        project_slug: "collide",
        new_slug: "cmo",
        slug_is_canonical: true,
      }),
    ).rejects.toThrow(/already exists in this project/);
  });

  it("copies workspace files via the gateway, skipping missing/erroring files", async () => {
    listAgentFilesMock.mockResolvedValueOnce({
      agentId: "src-cmo",
      workspace: "/ws",
      files: [
        { name: "REM.md", path: "/ws/REM.md", missing: false },
        { name: "GONE.md", path: "/ws/GONE.md", missing: true },
        { name: "BAD.md", path: "/ws/BAD.md", missing: false },
        { name: "OK.md", path: "/ws/OK.md", missing: false },
      ],
    });
    getAgentFileMock.mockImplementation(async (_id: string, name: string) => {
      if (name === "BAD.md") throw new Error("permission denied");
      return { agentId: "src-cmo", workspace: "/ws", file: { name, content: `body of ${name}` } };
    });
    setAgentFileMock.mockResolvedValue(undefined);
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);

    // Silence the SUT's console.error on the BAD.md skip.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await cloneAgent({
        source_agent_id: "src-cmo",
        project_slug: "proj1",
        new_slug: "custom-clone",
      });
      // 2 files copied (REM.md, OK.md). GONE.md was missing, BAD.md errored.
      expect(result.files_copied).toBe(2);
      expect(setAgentFileMock).toHaveBeenCalledWith(
        "proj1-custom-clone",
        "REM.md",
        "body of REM.md",
      );
      expect(setAgentFileMock).toHaveBeenCalledWith(
        "proj1-custom-clone",
        "OK.md",
        "body of OK.md",
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("copies sessions dir and rewrites sessions.json keys with the new agent prefix", async () => {
    const src = "srcproj-cmo";
    writeSourceSessionsDir(
      src,
      {
        "agent:srcproj-cmo:thread-1": { sessionId: "s1", updatedAt: 1 },
        "agent:srcproj-cmo:thread-2": { sessionId: "s2", updatedAt: 2 },
        // A key without our prefix is left untouched.
        "alien-key": { sessionId: "alien", updatedAt: 3 },
      },
      { "thread-1.jsonl": "log-line\n" },
    );

    listAgentFilesMock.mockResolvedValueOnce({ agentId: src, workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);

    const result = await cloneAgent({
      source_agent_id: src,
      project_slug: "dst",
      new_slug: "clone",
    });
    const dstSessionsDir = join(tmpHome, "agents", "dst-clone", "sessions");
    expect(existsSync(dstSessionsDir)).toBe(true);
    expect(existsSync(join(dstSessionsDir, "thread-1.jsonl"))).toBe(true);
    const rewritten = JSON.parse(
      readFileSync(join(dstSessionsDir, "sessions.json"), "utf8"),
    );
    expect(rewritten["agent:dst-clone:thread-1"]).toEqual({
      sessionId: "s1",
      updatedAt: 1,
    });
    expect(rewritten["agent:dst-clone:thread-2"]).toEqual({
      sessionId: "s2",
      updatedAt: 2,
    });
    // Alien keys are preserved as-is.
    expect(rewritten["alien-key"]).toEqual({ sessionId: "alien", updatedAt: 3 });
    expect(result.sessions_copied).toBe(3);
  });

  it("tolerates broken sessions.json by logging and reporting 0 sessions copied", async () => {
    const src = "broken-src";
    const dir = join(tmpHome, "agents", src, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessions.json"), "{ not json", "utf8");

    listAgentFilesMock.mockResolvedValueOnce({ agentId: src, workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await cloneAgent({
        source_agent_id: src,
        project_slug: "broken-dst",
        new_slug: "clone",
      });
      // sessions.json existed but couldn't be parsed — 0 sessions copied, no throw.
      expect(result.sessions_copied).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("recreates source crons under the new agent + project naming convention", async () => {
    // Write jobs.json with two crons assigned to the source agent + one
    // unrelated to a different agent (should be ignored).
    const cronDir = join(tmpHome, "cron");
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify([
        {
          id: "c1",
          name: "src/agent/morning-job",
          agentId: "cron-src-cmo",
          description: "morning",
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "do work" },
        },
        {
          id: "c2",
          name: "every-five",
          agentId: "cron-src-cmo",
          schedule: { kind: "every", everyMs: 5 * 60_000 },
          payload: { message: "tick" },
          enabled: false,
        },
        {
          id: "skip",
          name: "x",
          agentId: "other-agent",
          schedule: { kind: "cron", expr: "* * * * *" },
        },
      ]),
      "utf8",
    );

    listAgentFilesMock.mockResolvedValueOnce({ agentId: "cron-src-cmo", workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);
    // openclaw cron add — should be called twice, return ids.
    openclawMock
      .mockResolvedValueOnce({ id: "new-1" })
      .mockResolvedValueOnce({ id: "new-2" });

    const result = await cloneAgent({
      source_agent_id: "cron-src-cmo",
      project_slug: "destproj",
      new_slug: "destslug",
    });

    expect(result.new_cron_ids).toEqual(["new-1", "new-2"]);
    expect(result.source_crons.length).toBe(2);
    expect(result.source_crons.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    // c2 was enabled:false → disabled:true.
    const c2 = result.source_crons.find((c) => c.id === "c2")!;
    expect(c2.disabled).toBe(true);

    // First cron: cron expr + tz, --description + --message, --no-deliver.
    const firstArgs = openclawMock.mock.calls[0]![0] as string[];
    expect(firstArgs.slice(0, 2)).toEqual(["cron", "add"]);
    expect(firstArgs).toContain("--name");
    // Name = `<project>/<new-slug>/<last-segment-as-cron-slug>`. Source name
    // was "src/agent/morning-job" so last segment is "morning-job".
    const nameIdx = firstArgs.indexOf("--name");
    expect(firstArgs[nameIdx + 1]).toBe("destproj/destslug/morning-job");
    expect(firstArgs).toContain("--cron");
    expect(firstArgs).toContain("--tz");
    expect(firstArgs).toContain("--description");
    expect(firstArgs).toContain("--message");
    expect(firstArgs).toContain("--no-deliver");
    expect(firstArgs[firstArgs.indexOf("--message") + 1]).toBe("do work");
    // Agent target should be the NEW full id.
    expect(firstArgs[firstArgs.indexOf("--agent") + 1]).toBe("destproj-destslug");

    // Second cron: 'every' schedule + no description.
    const secondArgs = openclawMock.mock.calls[1]![0] as string[];
    expect(secondArgs).toContain("--every");
    expect(secondArgs[secondArgs.indexOf("--every") + 1]).toBe("5m");
    expect(secondArgs).not.toContain("--cron");
    expect(secondArgs).not.toContain("--description");
  });

  it("falls back to disabled hourly schedule when source has an unknown kind", async () => {
    const cronDir = join(tmpHome, "cron");
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify([
        {
          id: "weird",
          name: "src/agent/weird",
          agentId: "weird-src-cmo",
          schedule: { kind: "moon-cycle" },
        },
      ]),
      "utf8",
    );

    listAgentFilesMock.mockResolvedValueOnce({ agentId: "weird-src-cmo", workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);
    openclawMock.mockResolvedValueOnce({ id: "new-weird" });

    await cloneAgent({
      source_agent_id: "weird-src-cmo",
      project_slug: "weirdproj",
      new_slug: "weirdslug",
    });
    const args = openclawMock.mock.calls[0]![0] as string[];
    expect(args).toContain("--every");
    expect(args[args.indexOf("--every") + 1]).toBe("1h");
  });

  it("handles jobs.json wrapped in {jobs: [...]}", async () => {
    const cronDir = join(tmpHome, "cron");
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "j1",
            name: "src/agent/job",
            agentId: "wrap-src-cmo",
            schedule: { kind: "cron", expr: "0 9 * * *" },
          },
        ],
      }),
      "utf8",
    );

    listAgentFilesMock.mockResolvedValueOnce({ agentId: "wrap-src-cmo", workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);
    openclawMock.mockResolvedValueOnce({ id: "ok" });

    const r = await cloneAgent({
      source_agent_id: "wrap-src-cmo",
      project_slug: "wproj",
      new_slug: "wslug",
    });
    expect(r.new_cron_ids).toEqual(["ok"]);
  });

  it("continues when openclaw cron add fails on one cron", async () => {
    const cronDir = join(tmpHome, "cron");
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(
      join(cronDir, "jobs.json"),
      JSON.stringify([
        {
          id: "p1",
          name: "src/agent/a",
          agentId: "partial-src-cmo",
          schedule: { kind: "cron", expr: "0 9 * * *" },
        },
        {
          id: "p2",
          name: "src/agent/b",
          agentId: "partial-src-cmo",
          schedule: { kind: "cron", expr: "0 9 * * *" },
        },
      ]),
      "utf8",
    );
    listAgentFilesMock.mockResolvedValueOnce({ agentId: "partial-src-cmo", workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);
    openclawMock
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ id: "ok-2" });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await cloneAgent({
        source_agent_id: "partial-src-cmo",
        project_slug: "pproj",
        new_slug: "pslug",
      });
      // source_crons still records BOTH; new_cron_ids only the one that succeeded.
      expect(r.source_crons.length).toBe(2);
      expect(r.new_cron_ids).toEqual(["ok-2"]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("writes the notfair-meta sidecar after a successful clone", async () => {
    listAgentFilesMock.mockResolvedValueOnce({ agentId: "meta-src", workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);

    await cloneAgent({
      source_agent_id: "meta-src",
      project_slug: "metaproj",
      new_slug: "metaclone",
      display_name: "Custom Display",
    });

    const metaPath = join(
      tmpData,
      "agents",
      "metaproj-metaclone",
      "notfair-meta.json",
    );
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.agent_id).toBe("metaproj-metaclone");
    expect(meta.project_slug).toBe("metaproj");
    expect(meta.slug).toBe("metaclone");
    expect(meta.name).toBe("Custom Display");
    expect(meta.source_agent_id).toBe("meta-src");
    expect(typeof meta.created_at).toBe("string");
  });

  it("defaults name to the source agent id when display_name is not provided", async () => {
    listAgentFilesMock.mockResolvedValueOnce({ agentId: "no-display-src", workspace: "/ws", files: [] });
    createAgentViaRpcMock.mockResolvedValueOnce(undefined);
    await cloneAgent({
      source_agent_id: "no-display-src",
      project_slug: "ndproj",
      new_slug: "ndclone",
    });
    const meta = JSON.parse(
      readFileSync(
        join(tmpData, "agents", "ndproj-ndclone", "notfair-meta.json"),
        "utf8",
      ),
    );
    expect(meta.name).toBe("no-display-src");
  });
});
