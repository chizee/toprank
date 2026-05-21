import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks ────────────────────────────────────────────────────────────
// We're testing writeIdentityFile's COMPOSITION behavior end-to-end
// (file-on-disk shape), so:
//   - openclaw CLI: stubbed (we don't actually shell out)
//   - listProjects: empty (no legacy MCP cleanup needed)
//   - mcp-server/registration: stubbed (provisioning calls into it)
//   - agent-meta.writeAgentMeta: stubbed (also touches disk, not what we test)
// The real fs writes through.

vi.mock("@/server/openclaw/cli", () => ({
  openclaw: vi.fn(async (args: string[]) => {
    // ensureProjectAgents calls `openclaw agents list` to check existence,
    // and `openclaw agents add` to provision. Stub both as no-ops returning
    // an empty agent list so every template is treated as "new".
    if (args[0] === "agents" && args[1] === "list") return "";
    return undefined;
  }),
  OpenClawError: class extends Error {},
}));

vi.mock("@/server/db/projects", () => ({
  listProjects: () => [],
}));

vi.mock("@/server/mcp-server/registration", () => ({
  ensureOrchestrationMcpInstalled: vi.fn(async () => ({
    ok: true,
    status: "already_installed",
    key: "notfair-orchestration",
    url: "http://127.0.0.1:3326/api/mcp/orchestration",
  })),
  cleanupLegacyOrchestrationRows: vi.fn(async () => {}),
}));

vi.mock("@/server/agent-meta", () => ({
  writeAgentMeta: vi.fn(async () => {}),
}));

import { ensureProjectAgents, agentNameFor } from "./agent-templates";
import { getOrchestrationSkill } from "./skills/orchestration-skill";

let tmpDataDir: string;
const ORIGINAL_ENV = process.env.NOTFAIR_CMO_DATA_DIR;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "notfair-cmo-templates-"));
  process.env.NOTFAIR_CMO_DATA_DIR = tmpDataDir;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NOTFAIR_CMO_DATA_DIR;
  else process.env.NOTFAIR_CMO_DATA_DIR = ORIGINAL_ENV;
  if (tmpDataDir && existsSync(tmpDataDir)) {
    rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

function read(slug: string, file: "IDENTITY.md" | "SKILL.md"): string {
  return readFileSync(
    join(tmpDataDir, "agents", `${slug}`, file),
    "utf8",
  );
}

describe("ensureProjectAgents — IDENTITY.md per-agent + SKILL.md shared", () => {
  it("provisions CMO + Google Ads + SEO and writes both files for each", async () => {
    await ensureProjectAgents("demo");
    // Agent ids encode the personal name (default_name per template).
    for (const slug of ["demo-cmo-greg", "demo-google-ads-ana", "demo-seo-sam"]) {
      expect(existsSync(join(tmpDataDir, "agents", slug, "IDENTITY.md"))).toBe(
        true,
      );
      expect(existsSync(join(tmpDataDir, "agents", slug, "SKILL.md"))).toBe(
        true,
      );
    }
  });

  // System-prompt-size regression guard: OpenClaw seeds each workspace with
  // ~11 KB of generic boilerplate (camera tools, memory rituals, etc.) that
  // gets injected into every model call but doesn't apply to a marketing
  // CMO. We overwrite the five OpenClaw-default files with sub-300-char
  // stubs so the system prompt stays lean. If someone resurrects the
  // boilerplate, this test catches it.
  it("overwrites OpenClaw default workspace files with minimal stubs", async () => {
    await ensureProjectAgents("demo");
    for (const fname of [
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "USER.md",
      "HEARTBEAT.md",
    ]) {
      const path = join(tmpDataDir, "agents", "demo-cmo-greg", fname);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      // Generous bound; the stubs are ~150–300 chars. Anything beyond 1 KB
      // means the OpenClaw boilerplate snuck back in.
      expect(body.length).toBeLessThan(1024);
    }
  });

  it("SKILL.md is byte-identical across all three agents (shared source of truth)", async () => {
    await ensureProjectAgents("demo");
    const cmo = read("demo-cmo-greg", "SKILL.md");
    const ga = read("demo-google-ads-ana", "SKILL.md");
    const seo = read("demo-seo-sam", "SKILL.md");
    expect(cmo).toBe(ga);
    expect(ga).toBe(seo);
    // And matches the exported constant verbatim.
    expect(cmo).toBe(getOrchestrationSkill());
  });

  it("each IDENTITY.md pins the correct per-agent runtime identity", async () => {
    await ensureProjectAgents("demo");
    const cmo = read("demo-cmo-greg", "IDENTITY.md");
    const ga = read("demo-google-ads-ana", "IDENTITY.md");
    const seo = read("demo-seo-sam", "IDENTITY.md");

    // Every IDENTITY.md must mention this project + its own agent_id.
    expect(cmo).toMatch(/`project_slug`: `demo`/);
    expect(cmo).toMatch(/`agent_id`: `demo-cmo-greg`/);

    expect(ga).toMatch(/`project_slug`: `demo`/);
    expect(ga).toMatch(/`agent_id`: `demo-google-ads-ana`/);

    expect(seo).toMatch(/`project_slug`: `demo`/);
    expect(seo).toMatch(/`agent_id`: `demo-seo-sam`/);

    // Cross-agent leakage check: an agent must NOT see another agent's id.
    expect(cmo).not.toContain("`agent_id`: `demo-google-ads-ana`");
    expect(cmo).not.toContain("`agent_id`: `demo-seo-sam`");
    expect(ga).not.toContain("`agent_id`: `demo-cmo-greg`");
    expect(ga).not.toContain("`agent_id`: `demo-seo-sam`");
    expect(seo).not.toContain("`agent_id`: `demo-cmo-greg`");
    expect(seo).not.toContain("`agent_id`: `demo-google-ads-ana`");
  });

  it("each IDENTITY.md appends the full shared skill verbatim after the '---' separator", async () => {
    await ensureProjectAgents("demo");
    const skill = getOrchestrationSkill();
    for (const slug of ["demo-cmo-greg", "demo-google-ads-ana", "demo-seo-sam"]) {
      const body = read(slug, "IDENTITY.md");
      // The separator + skill appear AFTER the role-specific section.
      const sepIdx = body.indexOf("\n---\n");
      expect(sepIdx).toBeGreaterThan(0);
      const tail = body.slice(sepIdx);
      expect(tail).toContain(skill);
    }
  });

  it("CMO's role section says 'orchestrator' and specialist sections say 'specialist worker'", async () => {
    await ensureProjectAgents("demo");
    const cmo = read("demo-cmo-greg", "IDENTITY.md");
    const ga = read("demo-google-ads-ana", "IDENTITY.md");
    const seo = read("demo-seo-sam", "IDENTITY.md");

    expect(cmo).toContain("## Your role: orchestrator");
    expect(cmo).not.toContain("## Your role: specialist worker");

    expect(ga).toContain("## Your role: specialist worker");
    expect(ga).not.toContain("## Your role: orchestrator");

    expect(seo).toContain("## Your role: specialist worker");
    expect(seo).not.toContain("## Your role: orchestrator");
  });

  it("specialist IDENTITY.md mentions its domain tool (notfair-googleads / GSC)", async () => {
    await ensureProjectAgents("demo");
    const ga = read("demo-google-ads-ana", "IDENTITY.md");
    expect(ga).toContain("notfair-googleads MCP");
    expect(ga).toContain("ads.gaql");

    const seo = read("demo-seo-sam", "IDENTITY.md");
    expect(seo).toMatch(/Google Search Console/);
  });

  it("CMO IDENTITY.md does NOT contain specialist-only role text and vice versa", async () => {
    await ensureProjectAgents("demo");
    const cmo = read("demo-cmo-greg", "IDENTITY.md");
    const ga = read("demo-google-ads-ana", "IDENTITY.md");
    expect(cmo).not.toContain("## Your role: specialist worker");
    expect(ga).not.toContain("## Your role: orchestrator");
  });

  it("re-provisioning the same project rewrites IDENTITY.md (idempotent + picks up skill edits)", async () => {
    await ensureProjectAgents("demo");
    const before = read("demo-cmo-greg", "IDENTITY.md");
    await ensureProjectAgents("demo");
    const after = read("demo-cmo-greg", "IDENTITY.md");
    expect(after).toBe(before);
  });

  it("isolates identity across projects (no cross-project bleed)", async () => {
    await ensureProjectAgents("alpha");
    await ensureProjectAgents("beta");
    const alphaCmo = read("alpha-cmo-greg", "IDENTITY.md");
    const betaCmo = read("beta-cmo-greg", "IDENTITY.md");
    expect(alphaCmo).toContain("`project_slug`: `alpha`");
    expect(alphaCmo).toContain("`agent_id`: `alpha-cmo-greg`");
    expect(alphaCmo).not.toMatch(/`project_slug`: `beta`/);
    expect(alphaCmo).not.toMatch(/`agent_id`: `beta-cmo-greg`/);
    expect(betaCmo).toContain("`project_slug`: `beta`");
    expect(betaCmo).toContain("`agent_id`: `beta-cmo-greg`");
    expect(betaCmo).not.toMatch(/`project_slug`: `alpha`/);
  });
});

describe("agentNameFor (used to derive per-agent identity values)", () => {
  it("encodes <project-slug>-<role>-<slugified-name>", () => {
    expect(agentNameFor("demo", "cmo", "Greg")).toBe("demo-cmo-greg");
    expect(agentNameFor("demo", "google_ads", "Ana")).toBe(
      "demo-google-ads-ana",
    );
    expect(agentNameFor("demo", "seo", "Sam")).toBe("demo-seo-sam");
  });

  it("slugifies multi-word names + handles symbols", () => {
    expect(agentNameFor("demo", "google_ads", "Sam Q4!")).toBe(
      "demo-google-ads-sam-q4",
    );
  });
});
