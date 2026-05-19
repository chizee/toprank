import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────

const getMcpConfigMock = vi.fn();
const mcpRpcMock = vi.fn();
vi.mock("@/server/mcp/rpc", () => ({
  getMcpConfig: (...args: unknown[]) => getMcpConfigMock(...args),
  mcpRpc: (...args: unknown[]) => mcpRpcMock(...args),
}));

const logAgentActionMock = vi.fn();
vi.mock("@/server/db/agent-actions", () => ({
  logAgentAction: (...args: unknown[]) => logAgentActionMock(...args),
}));

const writeFileMock = vi.fn();
const mkdirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
}));

const openclawMock = vi.fn();
vi.mock("@/server/openclaw/cli", () => ({
  openclaw: (...args: unknown[]) => openclawMock(...args),
  OpenClawError: class OpenClawError extends Error {},
}));

import { runAudit, type AuditEvent } from "./audit";

// ── Fixtures ───────────────────────────────────────────────────────

/**
 * Fixtures mirror the REAL `ads.gaqlParallel` envelope shape (verified live
 * against notfair.co/api/mcp/google_ads on 2026-05-19): the script's return
 * is wrapped in `{ ok, result, resultTruncated, logs, timedOut, elapsedMs }`.
 * Campaign status comes as numeric enum + `status_name` string companion.
 * Rows use object-nested shape (campaign.name, metrics.cost_micros) — NOT
 * dotted keys. Bugs that ship under fixtures that don't match the live shape
 * silently classify accounts as empty (the regression that triggered this
 * test rewrite).
 */
const NORMAL_REPORTS_INNER = {
  wasted_spend: {
    rowCount: 4,
    rows: [
      {
        ad_group_criterion: { keyword: { text: "marketing automation" } },
        ad_group: { name: "Brand" },
        campaign: { name: "Brand-US" },
        metrics: { cost_micros: 420_000_000, conversions: 0, clicks: 300 },
      },
      {
        ad_group_criterion: { keyword: { text: "saas crm" } },
        ad_group: { name: "Brand" },
        campaign: { name: "Brand-US" },
        metrics: { cost_micros: 420_000_000, conversions: 0, clicks: 300 },
      },
      {
        ad_group_criterion: { keyword: { text: "best crm" } },
        ad_group: { name: "Brand" },
        campaign: { name: "Brand-US" },
        metrics: { cost_micros: 210_000_000, conversions: 0, clicks: 150 },
      },
      {
        ad_group_criterion: { keyword: { text: "ad ops" } },
        ad_group: { name: "Brand" },
        campaign: { name: "Brand-US" },
        metrics: { cost_micros: 210_000_000, conversions: 0, clicks: 450 },
      },
    ],
  },
  low_qs: {
    rowCount: 1,
    rows: [
      {
        ad_group_criterion: {
          keyword: { text: "kw1" },
          quality_info: { quality_score: 3 },
        },
        ad_group: { name: "Generic" },
        campaign: { name: "Generic-US" },
        metrics: { impressions: 500, cost_micros: 50_000_000 },
      },
    ],
  },
  search_term_gap: { rowCount: 0, rows: [] },
  budget_pacing: { rowCount: 0, rows: [] },
  campaigns_summary: {
    rowCount: 1,
    rows: [
      {
        campaign: { name: "Brand-US", status: 2, status_name: "ENABLED" },
        metrics: { cost_micros: 3_000_000_000, impressions: 50_000 },
      },
    ],
  },
};

const EMPTY_REPORTS_INNER = {
  wasted_spend: { rowCount: 0, rows: [] },
  low_qs: { rowCount: 0, rows: [] },
  search_term_gap: { rowCount: 0, rows: [] },
  budget_pacing: { rowCount: 0, rows: [] },
  campaigns_summary: { rowCount: 0, rows: [] },
};

/** Wrap inner reports in the runScript envelope and the MCP tool-call envelope. */
function mockToolCallResult(reports: unknown): {
  ok: true;
  result: { content: Array<{ type: string; text: string }>; isError: boolean };
} {
  const scriptEnvelope = {
    ok: true,
    result: reports,
    resultTruncated: false,
    logs: [],
    logsTruncated: false,
    timedOut: false,
    elapsedMs: 950,
  };
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(scriptEnvelope) }],
      isError: false,
    },
  };
}

const NORMAL_REPORTS = NORMAL_REPORTS_INNER;
const EMPTY_REPORTS = EMPTY_REPORTS_INNER;

async function collect(slug: string, signal?: AbortSignal): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  for await (const e of runAudit(slug, signal)) out.push(e);
  return out;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("runAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMcpConfigMock.mockResolvedValue({
      url: "https://notfair.co/api/mcp/google_ads",
      token: "tok",
    });
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    openclawMock.mockResolvedValue(undefined);
  });

  describe("happy path (normal account)", () => {
    beforeEach(() => {
      mcpRpcMock.mockResolvedValue(mockToolCallResult(NORMAL_REPORTS));
    });

    it("emits start → findings → complete in order", async () => {
      const events = await collect("acme");
      expect(events[0]).toEqual({ type: "audit:start" });
      expect(events.at(-1)).toMatchObject({ type: "audit:complete" });
      const findingEvents = events.filter((e) => e.type === "audit:finding");
      expect(findingEvents.length).toBeGreaterThan(0);
    });

    it("WASTED_SPEND finding references the offending campaign by name", async () => {
      const events = await collect("acme");
      const wasted = events.find(
        (e) => e.type === "audit:finding" && e.finding.category === "WASTED_SPEND",
      );
      expect(wasted).toBeDefined();
      if (wasted && wasted.type === "audit:finding") {
        expect(wasted.finding.headline).toContain("Brand-US");
        expect(wasted.finding.headline).toMatch(/burn/);
      }
    });

    it("persists the audit to agent_actions with category-errored count", async () => {
      await collect("acme");
      expect(logAgentActionMock).toHaveBeenCalledTimes(1);
      const call = logAgentActionMock.mock.calls[0]![0];
      expect(call.project_slug).toBe("acme");
      expect(call.action_type).toBe("audit_completed");
      expect(call.agent_id).toBe("acme-google-ads");
      expect(call.payload.summary.count).toBeGreaterThan(0);
    });

    it("writes FIRST_TURN.md to the CMO workspace", async () => {
      await collect("acme");
      expect(writeFileMock).toHaveBeenCalled();
      const [path, body] = writeFileMock.mock.calls[0]!;
      expect(String(path)).toMatch(/acme-cmo[\\/]FIRST_TURN\.md$/);
      expect(String(body)).toContain("# First-turn context for the CMO");
      expect(String(body)).toContain("acme");
      expect(String(body)).toContain("Top finding");
    });

    it("writes a memory tag via openclaw subprocess", async () => {
      await collect("acme");
      expect(openclawMock).toHaveBeenCalled();
      const [args] = openclawMock.mock.calls[0]!;
      expect(args).toContain("memory");
      expect(args).toContain("write");
      expect(args).toContain("--agent");
      expect(args).toContain("acme-cmo");
    });

    it("picks the highest-$-impact finding as top_fix", async () => {
      const events = await collect("acme");
      const complete = events.find((e) => e.type === "audit:complete");
      if (complete && complete.type === "audit:complete") {
        expect(complete.summary.top_fix_id).toMatch(/^wasted_spend:/);
      }
    });
  });

  describe("empty account (D5)", () => {
    beforeEach(() => {
      mcpRpcMock.mockResolvedValue(mockToolCallResult(EMPTY_REPORTS));
    });

    it("emits audit:empty before audit:complete", async () => {
      const events = await collect("acme");
      const emptyIdx = events.findIndex((e) => e.type === "audit:empty");
      const completeIdx = events.findIndex((e) => e.type === "audit:complete");
      expect(emptyIdx).toBeGreaterThan(-1);
      expect(completeIdx).toBeGreaterThan(emptyIdx);
    });

    it("records account_state='empty' on the agent_actions row", async () => {
      await collect("acme");
      const call = logAgentActionMock.mock.calls[0]![0];
      expect(call.payload.summary.account_state).toBe("empty");
    });

    it("FIRST_TURN.md contains the empty-account roadmap content", async () => {
      await collect("acme");
      const [, body] = writeFileMock.mock.calls[0]!;
      expect(String(body)).toContain("Set a daily budget");
      expect(String(body)).toContain("just getting started");
    });
  });

  describe("MCP failure modes", () => {
    it("emits stale_token error on 401", async () => {
      mcpRpcMock.mockResolvedValue({ ok: false, kind: "http_error", status: 401 });
      const events = await collect("acme");
      const err = events.find((e) => e.type === "audit:error");
      expect(err).toMatchObject({ type: "audit:error", kind: "stale_token" });
      // Did NOT persist or write FIRST_TURN.md when MCP failed.
      expect(logAgentActionMock).not.toHaveBeenCalled();
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it("emits unreachable error on 500", async () => {
      mcpRpcMock.mockResolvedValue({ ok: false, kind: "http_error", status: 500 });
      const events = await collect("acme");
      expect(events.find((e) => e.type === "audit:error")).toMatchObject({
        kind: "unreachable",
      });
    });

    it("emits timeout error on timeout", async () => {
      mcpRpcMock.mockResolvedValue({ ok: false, kind: "timeout" });
      const events = await collect("acme");
      expect(events.find((e) => e.type === "audit:error")).toMatchObject({
        kind: "timeout",
      });
    });

    it("emits rpc_error on JSON-RPC error envelope", async () => {
      mcpRpcMock.mockResolvedValue({
        ok: false,
        kind: "rpc_error",
        code: -32601,
        message: "Method not found",
      });
      const events = await collect("acme");
      expect(events.find((e) => e.type === "audit:error")).toMatchObject({
        kind: "rpc_error",
      });
    });

    it("emits malformed_response when MCP returns non-text content", async () => {
      mcpRpcMock.mockResolvedValue({
        ok: true,
        result: { content: [], isError: false },
      });
      const events = await collect("acme");
      expect(events.find((e) => e.type === "audit:error")).toMatchObject({
        kind: "malformed_response",
      });
    });

    it("emits mcp_not_configured when getMcpConfig returns null", async () => {
      getMcpConfigMock.mockResolvedValueOnce(null);
      mcpRpcMock.mockResolvedValue(mockToolCallResult(NORMAL_REPORTS));
      const events = await collect("acme");
      expect(events.find((e) => e.type === "audit:error")).toMatchObject({
        kind: "mcp_not_configured",
      });
      expect(mcpRpcMock).not.toHaveBeenCalled();
    });
  });

  describe("category-level errors (partial audit)", () => {
    it("emits audit:finding-error per failing category but continues", async () => {
      const mixed = {
        ...NORMAL_REPORTS,
        low_qs: { error: "quota exceeded for this surface" },
      };
      mcpRpcMock.mockResolvedValue(mockToolCallResult(mixed));
      const events = await collect("acme");
      const findingErr = events.find((e) => e.type === "audit:finding-error");
      expect(findingErr).toMatchObject({ category: "LOW_QS" });
      // Other findings still emitted + completion still fired.
      expect(events.some((e) => e.type === "audit:finding")).toBe(true);
      expect(events.some((e) => e.type === "audit:complete")).toBe(true);
    });
  });

  describe("D12: load-bearing SQLite write fail-loud", () => {
    beforeEach(() => {
      mcpRpcMock.mockResolvedValue(mockToolCallResult(NORMAL_REPORTS));
    });

    it("emits audit:persist-failed and stops (no complete) when logAgentAction throws", async () => {
      logAgentActionMock.mockImplementationOnce(() => {
        throw new Error("disk is full");
      });
      const events = await collect("acme");
      expect(events.some((e) => e.type === "audit:persist-failed")).toBe(true);
      expect(events.some((e) => e.type === "audit:complete")).toBe(false);
      // FIRST_TURN.md and memory writes did NOT run after persist failed.
      expect(writeFileMock).not.toHaveBeenCalled();
      expect(openclawMock).not.toHaveBeenCalled();
    });
  });

  describe("regression — real MCP envelope shape", () => {
    it("unwraps the runScript {ok, result} envelope (Demo2 bug — 2026-05-19)", async () => {
      // Build a payload WITHOUT the helper so we can exercise the unwrap path
      // explicitly. Live MCP wraps the script's return in {ok, result, ...}.
      // Before the fix, our parser returned the wrapper as the category dict
      // and findings disappeared (classified as empty).
      const inner = {
        wasted_spend: NORMAL_REPORTS_INNER.wasted_spend,
        low_qs: NORMAL_REPORTS_INNER.low_qs,
        search_term_gap: { rows: [] },
        budget_pacing: { rows: [] },
        campaigns_summary: NORMAL_REPORTS_INNER.campaigns_summary,
      };
      const envelopeText = JSON.stringify({
        ok: true,
        result: inner,
        resultTruncated: false,
        logs: [],
        timedOut: false,
        elapsedMs: 950,
      });
      mcpRpcMock.mockResolvedValueOnce({
        ok: true,
        result: {
          content: [{ type: "text", text: envelopeText }],
          isError: false,
        },
      });
      const events = await collect("acme");
      const complete = events.find((e) => e.type === "audit:complete");
      expect(complete, "should reach audit:complete with findings, not classify empty").toBeDefined();
      if (complete && complete.type === "audit:complete") {
        expect(complete.summary.account_state).toBe("normal");
        expect(complete.summary.count).toBeGreaterThan(0);
      }
    });

    it("treats campaign.status_name='ENABLED' as enabled even when status is the numeric enum (Demo2 bug — 2026-05-19)", async () => {
      // Live shape: campaign.status is the integer enum (2 = ENABLED) and
      // campaign.status_name is the string companion. Before the fix, the
      // classifier checked .status === 'ENABLED' (string compare against
      // an integer), got false, and classified the account empty even
      // when a real campaign was running.
      const numericOnly = {
        ...EMPTY_REPORTS_INNER,
        campaigns_summary: {
          rowCount: 1,
          rows: [
            {
              campaign: { name: "NotFair - Google Ads", status: 2, status_name: "ENABLED" },
              metrics: { cost_micros: 39_390_000, impressions: 42 },
            },
          ],
        },
      };
      mcpRpcMock.mockResolvedValueOnce(mockToolCallResult(numericOnly));
      const events = await collect("acme");
      // Spend is $39 (over the $10 threshold) and status enum says ENABLED,
      // so account_state should NOT be 'empty'.
      const complete = events.find((e) => e.type === "audit:complete");
      if (complete && complete.type === "audit:complete") {
        expect(complete.summary.account_state).toBe("normal");
      }
    });

    it("classifies as empty when ok=false (script-side error in envelope)", async () => {
      // Defensive: if the runScript envelope reports ok=false, treat as
      // malformed_response so the user sees a real error instead of silent
      // 'empty' misclassification.
      const errorEnvelope = JSON.stringify({
        ok: false,
        error: { message: "GAQL syntax error" },
      });
      mcpRpcMock.mockResolvedValueOnce({
        ok: true,
        result: {
          content: [{ type: "text", text: errorEnvelope }],
          isError: false,
        },
      });
      const events = await collect("acme");
      expect(events.find((e) => e.type === "audit:error")).toMatchObject({
        kind: "malformed_response",
      });
    });
  });

  describe("D7: best-effort FIRST_TURN.md + memory writes", () => {
    beforeEach(() => {
      mcpRpcMock.mockResolvedValue(mockToolCallResult(NORMAL_REPORTS));
    });

    it("completes audit even when FIRST_TURN.md write fails", async () => {
      writeFileMock.mockRejectedValueOnce(new Error("ENOSPC"));
      const events = await collect("acme");
      expect(events.some((e) => e.type === "audit:complete")).toBe(true);
    });

    it("completes audit even when memory write fails", async () => {
      openclawMock.mockRejectedValueOnce(new Error("memory service down"));
      const events = await collect("acme");
      expect(events.some((e) => e.type === "audit:complete")).toBe(true);
    });
  });
});
