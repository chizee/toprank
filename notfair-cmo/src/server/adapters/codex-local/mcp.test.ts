import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory fs mock ──────────────────────────────────────────────────

interface FsState {
  files: Map<string, string>;
  dirs: Set<string>;
}
const fsState: FsState = { files: new Map(), dirs: new Set() };

vi.mock("node:fs", () => ({
  existsSync: (p: string) => fsState.files.has(p),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: async (p: string) => {
    fsState.dirs.add(p);
  },
  readFile: async (p: string) => {
    const v = fsState.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  writeFile: async (p: string, content: string) => {
    fsState.files.set(p, content);
  },
}));

beforeEach(() => {
  fsState.files.clear();
  fsState.dirs.clear();
  process.env.CODEX_HOME = "/codex";
});

afterEach(() => {
  delete process.env.CODEX_HOME;
});

// Imported after the mock so the in-memory fs is the one the module uses.
import {
  CODEX_BEARER_ENV_VAR,
  registerCodexMcp,
  unregisterCodexMcp,
} from "./mcp";
import type { McpRegistrationSpec } from "../types";

function makeHttpSpec(
  overrides: Partial<McpRegistrationSpec> = {},
): McpRegistrationSpec {
  return {
    serverName: "notfair-orchestration",
    agentId: "acme-cmo-greg",
    projectSlug: "acme",
    transport: {
      type: "http",
      url: "http://127.0.0.1:3326/api/mcp/orchestration",
      headers: { Authorization: "Bearer s3cret" },
    },
    ...overrides,
  };
}

describe("registerCodexMcp (http)", () => {
  it("emits bearer_token_env_var instead of raw Authorization header", async () => {
    await registerCodexMcp(makeHttpSpec());
    const toml = fsState.files.get("/codex/config.toml") ?? "";
    expect(toml).toContain(
      `[mcp_servers.notfair_acme_cmo_greg__notfair_orchestration]`,
    );
    expect(toml).toContain(
      `url = "http://127.0.0.1:3326/api/mcp/orchestration"`,
    );
    expect(toml).toContain(
      `bearer_token_env_var = ${JSON.stringify(CODEX_BEARER_ENV_VAR)}`,
    );
    // Regression: codex 0.132+ marks raw `headers = {Authorization=...}` as
    // Auth: Unsupported and refuses to expose the MCP tools.
    expect(toml).not.toMatch(/headers\s*=\s*\{\s*Authorization/);
    expect(toml).not.toContain("s3cret");
  });

  it("preserves non-Authorization headers verbatim", async () => {
    await registerCodexMcp(
      makeHttpSpec({
        transport: {
          type: "http",
          url: "https://example.test/mcp",
          headers: {
            Authorization: "Bearer s3cret",
            "X-Custom": "yes",
          },
        },
      }),
    );
    const toml = fsState.files.get("/codex/config.toml") ?? "";
    expect(toml).toContain(`bearer_token_env_var = ${JSON.stringify(CODEX_BEARER_ENV_VAR)}`);
    expect(toml).toContain(`headers = { X-Custom = "yes" }`);
  });

  it("is idempotent on re-registration (single section, no duplicates)", async () => {
    await registerCodexMcp(makeHttpSpec());
    await registerCodexMcp(makeHttpSpec());
    const toml = fsState.files.get("/codex/config.toml") ?? "";
    const matches = toml.match(
      /\[mcp_servers\.notfair_acme_cmo_greg__notfair_orchestration\]/g,
    );
    expect(matches?.length).toBe(1);
  });

  it("namespaces by agent id so two agents don't collide", async () => {
    await registerCodexMcp(makeHttpSpec({ agentId: "acme-cmo-greg" }));
    await registerCodexMcp(makeHttpSpec({ agentId: "acme-google-ads-ana" }));
    const toml = fsState.files.get("/codex/config.toml") ?? "";
    expect(toml).toContain(
      `[mcp_servers.notfair_acme_cmo_greg__notfair_orchestration]`,
    );
    expect(toml).toContain(
      `[mcp_servers.notfair_acme_google_ads_ana__notfair_orchestration]`,
    );
  });
});

describe("registerCodexMcp (stdio)", () => {
  it("writes command + args; no bearer env var (stdio uses inline env)", async () => {
    await registerCodexMcp({
      serverName: "stdio-thing",
      agentId: "acme-cmo-greg",
      projectSlug: "acme",
      transport: {
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { KEY: "v" },
      },
    });
    const toml = fsState.files.get("/codex/config.toml") ?? "";
    expect(toml).toContain(`command = "node"`);
    expect(toml).toContain(`args = ["server.js"]`);
    expect(toml).toContain(`env = { KEY = "v" }`);
    expect(toml).not.toContain("bearer_token_env_var");
  });
});

describe("unregisterCodexMcp", () => {
  it("removes only the matching section", async () => {
    await registerCodexMcp(makeHttpSpec({ agentId: "acme-cmo-greg" }));
    await registerCodexMcp(makeHttpSpec({ agentId: "acme-google-ads-ana" }));
    await unregisterCodexMcp("notfair-orchestration", "acme-cmo-greg");
    const toml = fsState.files.get("/codex/config.toml") ?? "";
    expect(toml).not.toContain("notfair_acme_cmo_greg__");
    expect(toml).toContain("notfair_acme_google_ads_ana__");
  });
});
