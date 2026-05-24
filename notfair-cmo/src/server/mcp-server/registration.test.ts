import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openclawMock = vi.fn();
vi.mock("@/server/openclaw/cli", () => {
  class FakeOpenClawError extends Error {
    exitCode: number | null;
    stderr: string;
    constructor(message: string, stderr = "", exitCode = 1) {
      super(message);
      this.name = "OpenClawError";
      this.stderr = stderr;
      this.exitCode = exitCode;
    }
  }
  return {
    openclaw: (...a: unknown[]) => openclawMock(...a),
    OpenClawError: FakeOpenClawError,
  };
});
import { OpenClawError } from "@/server/openclaw/cli";

const getSecretMock = vi.fn(() => "deadbeef".repeat(8));
vi.mock("./secret", () => ({
  getOrCreateMcpServerSecret: () => getSecretMock(),
}));

import {
  cleanupLegacyOrchestrationRows,
  ensureOrchestrationMcpInstalled,
  getOrchestrationMcpUrl,
  installOrchestrationMcp,
  ORCHESTRATION_MCP_KEY,
} from "./registration";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  openclawMock.mockReset();
  getSecretMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("ORCHESTRATION_MCP_KEY", () => {
  it("is a stable global key (no project prefix)", () => {
    expect(ORCHESTRATION_MCP_KEY).toBe("notfair-orchestration");
  });
});

describe("getOrchestrationMcpUrl", () => {
  it("defaults to http://127.0.0.1:3326/api/mcp/orchestration", () => {
    delete process.env.NOTFAIR_CMO_PORT;
    delete process.env.NOTFAIR_CMO_MCP_URL;
    expect(getOrchestrationMcpUrl()).toBe(
      "http://127.0.0.1:3326/api/mcp/orchestration",
    );
  });

  it("respects NOTFAIR_CMO_PORT", () => {
    process.env.NOTFAIR_CMO_PORT = "4001";
    delete process.env.NOTFAIR_CMO_MCP_URL;
    expect(getOrchestrationMcpUrl()).toBe(
      "http://127.0.0.1:4001/api/mcp/orchestration",
    );
  });

  it("NOTFAIR_CMO_MCP_URL overrides the host:port construction", () => {
    process.env.NOTFAIR_CMO_MCP_URL = "https://example.invalid/mcp";
    expect(getOrchestrationMcpUrl()).toBe("https://example.invalid/mcp");
  });
});

describe("ensureOrchestrationMcpInstalled", () => {
  it("installs when the row is missing (mcp show fails)", async () => {
    // First call: openclaw mcp show → throws OpenClawError (row missing).
    // Second call: openclaw mcp set → resolves.
    openclawMock
      .mockRejectedValueOnce(new OpenClawError("not found", "", 1))
      .mockResolvedValueOnce(undefined);
    const r = await ensureOrchestrationMcpInstalled();
    if (!r.ok) throw new Error("expected ok");
    expect(r.status).toBe("installed");
    expect(r.key).toBe("notfair-orchestration");
    expect(openclawMock).toHaveBeenLastCalledWith(
      ["mcp", "set", "notfair-orchestration", expect.any(String)],
      { json: false },
    );
  });

  it("no-ops with status 'already_installed' when row matches desired config", async () => {
    const url = "http://127.0.0.1:3326/api/mcp/orchestration";
    delete process.env.NOTFAIR_CMO_PORT;
    delete process.env.NOTFAIR_CMO_MCP_URL;
    openclawMock.mockResolvedValueOnce({
      url,
      transport: "streamable-http",
      headers: { Authorization: `Bearer ${"deadbeef".repeat(8)}` },
    });
    const r = await ensureOrchestrationMcpInstalled();
    if (!r.ok) throw new Error("expected ok");
    expect(r.status).toBe("already_installed");
    // Only the show call happened — no set.
    expect(openclawMock).toHaveBeenCalledTimes(1);
  });

  it("re-installs with status 'updated' when stored config drifts (URL changed)", async () => {
    openclawMock
      .mockResolvedValueOnce({
        url: "http://old.invalid/mcp",
        transport: "streamable-http",
        headers: { Authorization: `Bearer ${"deadbeef".repeat(8)}` },
      })
      .mockResolvedValueOnce(undefined);
    const r = await ensureOrchestrationMcpInstalled();
    if (!r.ok) throw new Error("expected ok");
    expect(r.status).toBe("updated");
    expect(openclawMock).toHaveBeenLastCalledWith(
      ["mcp", "set", "notfair-orchestration", expect.any(String)],
      { json: false },
    );
  });

  it("returns ok:false with the OpenClaw error on set failure", async () => {
    openclawMock
      .mockRejectedValueOnce(new OpenClawError("not found", "", 1))
      .mockRejectedValueOnce(new OpenClawError("write blew up", "perm denied", 1));
    const r = await ensureOrchestrationMcpInstalled();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/write blew up/);
  });
});

describe("installOrchestrationMcp (unconditional)", () => {
  it("always writes the row", async () => {
    openclawMock.mockResolvedValue(undefined);
    const r = await installOrchestrationMcp();
    if (!r.ok) throw new Error("expected ok");
    expect(r.status).toBe("installed");
    expect(openclawMock).toHaveBeenCalledWith(
      ["mcp", "set", "notfair-orchestration", expect.any(String)],
      { json: false },
    );
  });
});

describe("cleanupLegacyOrchestrationRows", () => {
  it("unsets one row per slug; swallows per-row errors", async () => {
    openclawMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new OpenClawError("not found", "", 1))
      .mockResolvedValueOnce(undefined);
    await expect(
      cleanupLegacyOrchestrationRows(["a", "b", "c"]),
    ).resolves.toBeUndefined();
    expect(openclawMock).toHaveBeenCalledTimes(3);
    expect(openclawMock).toHaveBeenNthCalledWith(
      1,
      ["mcp", "unset", "a-notfair-orchestration"],
      { json: false },
    );
    expect(openclawMock).toHaveBeenNthCalledWith(
      3,
      ["mcp", "unset", "c-notfair-orchestration"],
      { json: false },
    );
  });

  it("no-op on empty slug list", async () => {
    await cleanupLegacyOrchestrationRows([]);
    expect(openclawMock).not.toHaveBeenCalled();
  });
});
