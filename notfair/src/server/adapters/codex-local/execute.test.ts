import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessEvent, HarnessExecuteContext } from "../types";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveCodexBinary: vi.fn(() => "codex"),
  getOrCreateMcpServerSecret: vi.fn(() => "machine-secret"),
  listProjectMcpTokens: vi.fn(() => [] as { server_name: string; access_token_enc: string }[]),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./binary", () => ({
  resolveCodexBinary: mocks.resolveCodexBinary,
}));
vi.mock("@/server/mcp-server/secret", () => ({
  getOrCreateMcpServerSecret: mocks.getOrCreateMcpServerSecret,
}));
vi.mock("@/server/mcp/tokens", () => ({
  listProjectMcpTokens: mocks.listProjectMcpTokens,
}));

import { executeCodexLocal } from "./execute";

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

interface Script {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: Error;
}

function scriptSpawn(script: Script): FakeChild {
  const child = new FakeChild();
  mocks.spawn.mockImplementationOnce(() => {
    setImmediate(async () => {
      if (script.spawnError) {
        child.emit("error", script.spawnError);
        return;
      }
      if (script.stdout) child.stdout.write(script.stdout);
      if (script.stderr) child.stderr.write(script.stderr);
      await new Promise((r) => setTimeout(r, 15));
      child.emit("close", script.exitCode ?? 0);
    });
    return child;
  });
  return child;
}

async function collect(ctx: HarnessExecuteContext): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const evt of executeCodexLocal(ctx)) events.push(evt);
  return events;
}

let workspaceDir: string;

function ctx(overrides: Partial<HarnessExecuteContext> = {}): HarnessExecuteContext {
  return {
    projectSlug: "proj",
    agentId: "agent-1",
    workspaceDir,
    message: "do the thing",
    threadId: "thread-1",
    ...overrides,
  };
}

const completedTurn =
  `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } })}\n` +
  `${JSON.stringify({ type: "turn.completed" })}\n`;

beforeEach(async () => {
  mocks.spawn.mockReset();
  mocks.listProjectMcpTokens.mockReturnValue([]);
  workspaceDir = await mkdtemp(join(tmpdir(), "notfair-codex-exec-"));
});

describe("executeCodexLocal — argv and env wiring", () => {
  it("spawns codex exec --json unsandboxed with stdin prompt", async () => {
    const child = scriptSpawn({ stdout: completedTurn });
    const events = await collect(ctx());

    const [bin, args, opts] = mocks.spawn.mock.calls[0]!;
    expect(bin).toBe("codex");
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ]);
    expect(opts).toMatchObject({ cwd: workspaceDir });
    expect(child.stdin.write).toHaveBeenCalledWith("do the thing");
    expect(child.stdin.end).toHaveBeenCalled();
    expect(events).toEqual([
      { kind: "delta", text: "ok" },
      { kind: "final", text: "ok" },
    ]);
  });

  it("injects one bearer env var per MCP server for the project", async () => {
    mocks.listProjectMcpTokens.mockReturnValue([
      { server_name: "notfair-googleads", access_token_enc: "oauth-token" },
    ]);
    scriptSpawn({ stdout: completedTurn });
    await collect(ctx());

    expect(mocks.listProjectMcpTokens).toHaveBeenCalledWith("proj");
    const env = (mocks.spawn.mock.calls[0]![2] as { env: Record<string, string> }).env;
    expect(env.NOTFAIR_MCP_BEARER__NOTFAIR_GOALS).toBe("machine-secret");
    expect(env.NOTFAIR_MCP_BEARER__NOTFAIR_BROWSER).toBe("machine-secret");
    expect(env.NOTFAIR_MCP_BEARER__NOTFAIR_GOOGLEADS).toBe("oauth-token");
    expect(env.NOTFAIR_PROJECT_SLUG).toBe("proj");
    expect(env.NOTFAIR_AGENT_ID).toBe("agent-1");
  });

  it("passes -m for the model override and resumes real codex thread ids", async () => {
    scriptSpawn({ stdout: completedTurn });
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    await collect(ctx({ model: "gpt-5.5", harnessSessionId: uuid }));

    const args = mocks.spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(args.slice(-3)).toEqual(["resume", uuid, "-"]);
  });

  it("passes a whitelisted reasoning effort as a Codex config override", async () => {
    scriptSpawn({ stdout: completedTurn });
    await collect(ctx({ reasoningEffort: "xhigh" }));

    const args = mocks.spawn.mock.calls[0]![1] as string[];
    expect(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2)).toEqual([
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("does not resume with a non-codex session id", async () => {
    scriptSpawn({ stdout: completedTurn });
    await collect(ctx({ harnessSessionId: "sess-not-uuid" }));
    const args = mocks.spawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain("resume");
    expect(args.at(-1)).toBe("-");
  });
});

describe("executeCodexLocal — stream handling", () => {
  it("forwards session + events and flushes a tail line without a newline", async () => {
    const l1 = JSON.stringify({ type: "thread.started", thread_id: "th-9" });
    const l2 = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hey" },
    });
    const l3 = JSON.stringify({ type: "turn.completed" }); // no trailing \n
    scriptSpawn({ stdout: `${l1}\n${l2}\n${l3}` });

    const events = await collect(ctx());
    expect(events).toEqual([
      { kind: "lifecycle", phase: "start" },
      { kind: "session", harnessSessionId: "th-9" },
      { kind: "delta", text: "hey" },
      { kind: "final", text: "hey" },
    ]);
  });

  it("appends the exit-code error with stderr tail even after a finalized turn", async () => {
    scriptSpawn({ stdout: completedTurn, stderr: "warn\nfatal: token expired\n", exitCode: 2 });
    const events = await collect(ctx());
    expect(events).toEqual([
      { kind: "delta", text: "ok" },
      { kind: "final", text: "ok" },
      { kind: "error", message: "codex exited with code 2: warn\nfatal: token expired" },
    ]);
  });

  it("yields a terminal error when codex fails to spawn", async () => {
    scriptSpawn({ spawnError: new Error("spawn codex ENOENT") });
    const events = await collect(ctx());
    expect(events).toEqual([{ kind: "error", message: "spawn codex ENOENT" }]);
  });

  it("kills the subprocess when the abort signal fires", async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    child.kill = vi.fn(() => {
      child.emit("close", 143);
      return true;
    });
    mocks.spawn.mockImplementationOnce(() => {
      setImmediate(() => controller.abort());
      return child;
    });

    const events = await collect(ctx({ signal: controller.signal }));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(events).toEqual([
      { kind: "error", message: "codex exited with code 143" },
    ]);
  });
});
