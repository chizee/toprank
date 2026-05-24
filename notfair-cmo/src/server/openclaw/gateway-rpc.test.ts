import { beforeEach, describe, expect, it, vi } from "vitest";

type MockedClient = {
  open: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const clientInstances: MockedClient[] = [];

let nextRequestImpl: ((method: string, params?: unknown) => unknown) | null = null;

vi.mock("./gateway-client", () => {
  class FakeGatewayClient {
    open: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    constructor() {
      const impl = nextRequestImpl ?? (async () => undefined);
      nextRequestImpl = null;
      this.open = vi.fn().mockResolvedValue(undefined);
      this.request = vi.fn().mockImplementation(impl);
      this.close = vi.fn();
      clientInstances.push(this);
    }
  }
  return { GatewayClient: FakeGatewayClient };
});

import {
  createAgentViaRpc,
  deleteAgent,
  getAgentFile,
  getSkillStatus,
  listAgentFiles,
  listAllAgents,
  setAgentFile,
  setSkillEnabled,
  updateCronMessage,
} from "./gateway-rpc";

function latest(): MockedClient {
  return clientInstances[clientInstances.length - 1]!;
}

function nextRequestReturns(value: unknown): void {
  nextRequestImpl = async () => value;
}

function nextRequestThrows(err: Error): void {
  nextRequestImpl = async () => {
    throw err;
  };
}

describe("gateway-rpc", () => {
  beforeEach(() => {
    clientInstances.length = 0;
    nextRequestImpl = null;
  });

  it("listAgentFiles opens, requests agents.files.list, returns payload, then closes", async () => {
    const expected = {
      agentId: "demo-agent",
      workspace: "/ws",
      files: [{ name: "REM.md", path: "/ws/REM.md", missing: false, size: 10 }],
    };
    nextRequestReturns(expected);

    await expect(listAgentFiles("demo-agent")).resolves.toEqual(expected);
    const c = latest();
    expect(c.open).toHaveBeenCalledTimes(1);
    expect(c.request).toHaveBeenCalledWith("agents.files.list", { agentId: "demo-agent" });
    expect(c.close).toHaveBeenCalledTimes(1);
  });

  it("closes the client even when the request throws", async () => {
    nextRequestThrows(new Error("boom"));
    await expect(listAgentFiles("a")).rejects.toThrow("boom");
    expect(latest().close).toHaveBeenCalled();
  });

  it("getAgentFile requests agents.files.get with agentId + name", async () => {
    const out = {
      agentId: "a",
      workspace: "/w",
      file: { name: "TODO.md", path: "/w/TODO.md", missing: false, content: "hi" },
    };
    nextRequestReturns(out);
    await expect(getAgentFile("a", "TODO.md")).resolves.toEqual(out);
    expect(latest().request).toHaveBeenCalledWith("agents.files.get", {
      agentId: "a",
      name: "TODO.md",
    });
  });

  it("setAgentFile requests agents.files.set and resolves void", async () => {
    await setAgentFile("a", "n", "content");
    expect(latest().request).toHaveBeenCalledWith("agents.files.set", {
      agentId: "a",
      name: "n",
      content: "content",
    });
  });

  it("getSkillStatus requests skills.status with agentId", async () => {
    const out = {
      workspaceDir: "/w",
      managedSkillsDir: "/w/skills",
      agentId: "a",
      skills: [],
    };
    nextRequestReturns(out);
    await expect(getSkillStatus("a")).resolves.toEqual(out);
    expect(latest().request).toHaveBeenCalledWith("skills.status", { agentId: "a" });
  });

  it("setSkillEnabled requests skills.update with skillKey + enabled flag", async () => {
    await setSkillEnabled("my-skill", true);
    expect(latest().request).toHaveBeenCalledWith("skills.update", {
      skillKey: "my-skill",
      enabled: true,
    });
    await setSkillEnabled("my-skill", false);
    expect(latest().request).toHaveBeenCalledWith("skills.update", {
      skillKey: "my-skill",
      enabled: false,
    });
  });

  it("deleteAgent requests agents.delete with deleteFiles:true", async () => {
    await deleteAgent("a");
    expect(latest().request).toHaveBeenCalledWith("agents.delete", {
      agentId: "a",
      deleteFiles: true,
    });
  });

  it("listAllAgents requests agents.list with empty params", async () => {
    const out = { defaultId: "a", mainKey: "main", agents: [] };
    nextRequestReturns(out);
    await expect(listAllAgents()).resolves.toEqual(out);
    expect(latest().request).toHaveBeenCalledWith("agents.list", {});
  });

  it("createAgentViaRpc forwards the full input as params", async () => {
    const input = { name: "demo-cmo", workspace: "/ws", model: "claude-opus-4", emoji: "🎯" };
    await createAgentViaRpc(input);
    expect(latest().request).toHaveBeenCalledWith("agents.create", input);
  });

  it("updateCronMessage wraps the new message in a payload patch", async () => {
    await updateCronMessage("cron-id", "fresh prompt");
    expect(latest().request).toHaveBeenCalledWith("cron.update", {
      id: "cron-id",
      patch: { payload: { kind: "agentTurn", message: "fresh prompt" } },
    });
  });

  it("each call opens a fresh GatewayClient instance and closes it", async () => {
    await setAgentFile("a", "f", "");
    await setAgentFile("a", "g", "");
    expect(clientInstances.length).toBe(2);
    for (const c of clientInstances) {
      expect(c.open).toHaveBeenCalledTimes(1);
      expect(c.close).toHaveBeenCalledTimes(1);
    }
  });
});
