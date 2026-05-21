"use server";

import { revalidatePath } from "next/cache";

import { getMcpConfig, mcpRpc } from "@/server/mcp/rpc";
import { storedMcpKey } from "@/server/mcp-catalog";
import { getProject, setProjectGoogleAdsAccount } from "@/server/db/projects";
import type { Project } from "@/types";

/**
 * Google Ads account picker for onboarding step=account.
 *
 * notfair.co's MCP bearer can grant access to multiple customer accounts
 * (Demo2 case: 5 accounts under one bearer). The onboarding flow asks the
 * user to pick one and we persist the choice on `projects.google_ads_account_id`
 * so the audit + later automation target the right account.
 *
 * Single source of truth for the account ID is the DB column. MCP returns
 * a `defaultAccountId` we surface only as a hint; we never silently use it.
 */

export type GoogleAdsAccount = { id: string; name: string };

export type ListAccountsResult =
  | { ok: true; accounts: GoogleAdsAccount[]; default_account_id: string | null }
  | { ok: false; error: string; kind: "mcp_not_configured" | "rpc" | "shape" };

type ListAccountsToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type AccountsPayload = {
  accounts?: Array<{ id?: unknown; name?: unknown }>;
  defaultAccountId?: unknown;
  totalAccounts?: unknown;
};

const MCP_CATALOG_KEY = "notfair-googleads";
const LIST_TIMEOUT_MS = 8_000;

/**
 * Call the MCP's listConnectedAccounts tool with the project's stored bearer.
 * Returns the account list (id + name) + the MCP's default-account hint.
 */
export async function listGoogleAdsAccounts(
  project_slug: string,
): Promise<ListAccountsResult> {
  const cfg = await getMcpConfig(storedMcpKey(project_slug, MCP_CATALOG_KEY));
  if (!cfg) {
    return {
      ok: false,
      kind: "mcp_not_configured",
      error: "Google Ads MCP is not configured for this project.",
    };
  }

  const rpcResult = await mcpRpc<ListAccountsToolResult>(
    cfg.url,
    cfg.token,
    "tools/call",
    { name: "listConnectedAccounts", arguments: {} },
    { timeoutMs: LIST_TIMEOUT_MS },
  );

  if (!rpcResult.ok) {
    const message =
      rpcResult.kind === "http_error"
        ? `HTTP ${rpcResult.status}`
        : rpcResult.kind === "rpc_error"
          ? `RPC ${rpcResult.code}: ${rpcResult.message}`
          : rpcResult.kind === "timeout"
            ? "MCP call timed out"
            : rpcResult.kind === "aborted"
              ? "MCP call aborted"
              : rpcResult.kind === "malformed_response"
                ? rpcResult.message
                : rpcResult.message;
    return { ok: false, kind: "rpc", error: message };
  }

  const parsed = parseAccountsPayload(rpcResult.result);
  if (!parsed) {
    return {
      ok: false,
      kind: "shape",
      error: "MCP listConnectedAccounts returned an unexpected shape.",
    };
  }
  return { ok: true, ...parsed };
}

function parseAccountsPayload(
  result: ListAccountsToolResult,
): { accounts: GoogleAdsAccount[]; default_account_id: string | null } | null {
  if (!result || typeof result !== "object") return null;
  if (result.isError) return null;
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") return null;
  let body: AccountsPayload;
  try {
    body = JSON.parse(text) as AccountsPayload;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.accounts)) {
    return null;
  }
  const accounts: GoogleAdsAccount[] = [];
  for (const a of body.accounts) {
    if (!a || typeof a !== "object") continue;
    const id = String(a.id ?? "").trim();
    const name = String(a.name ?? "").trim() || id;
    if (id) accounts.push({ id, name });
  }
  const default_account_id =
    typeof body.defaultAccountId === "string" || typeof body.defaultAccountId === "number"
      ? String(body.defaultAccountId)
      : null;
  return { accounts, default_account_id };
}

export type SetAccountResult =
  | { ok: true; project: Project; task_display_id: string }
  | { ok: false; error: string };

/**
 * Finishes onboarding in one round-trip:
 *
 *   1. Validates the account_id against the MCP's reachable list
 *      (anti-tamper for the form submit).
 *   2. Persists it on the project row.
 *   3. Mints the CMO's first task with the audit brief in `proposed`
 *      state. The task workspace the user lands on auto-fires the
 *      kickoff via /api/chat, so the user sees streaming gateway events
 *      live — JSONL polling alone can't (OpenClaw's codex-app-server
 *      mode flushes the file once per turn, not incrementally).
 *
 * The caller redirects to /agents/cmo/tasks?task=<display_id> so the user
 * watches the live audit stream the moment the page mounts.
 */
export async function setOnboardingAccountAction(
  project_slug: string,
  account_id: string,
): Promise<SetAccountResult> {
  if (!project_slug.trim() || !account_id.trim()) {
    return { ok: false, error: "Missing project slug or account id." };
  }
  const project = getProject(project_slug);
  if (!project) return { ok: false, error: "Project not found." };

  // Validate the account exists for this bearer. Defends against URL/form
  // tampering that would otherwise let a user persist any string here.
  const list = await listGoogleAdsAccounts(project_slug);
  if (!list.ok) {
    return {
      ok: false,
      error: `Couldn't verify account against MCP: ${list.error}`,
    };
  }
  const match = list.accounts.find((a) => a.id === account_id);
  if (!match) {
    return {
      ok: false,
      error: `Account ${account_id} isn't in this bearer's reachable accounts.`,
    };
  }

  const updated = setProjectGoogleAdsAccount(project_slug, match.id);
  if (!updated) return { ok: false, error: "Project not found." };

  // Mint the audit task — gated on the project-onboarding task that
  // createProjectForOnboardingAction kicked off in the background. The
  // audit can't run until PROJECT.md exists; the propagation hook in
  // handleTaskStatus auto-starts the audit the moment onboarding flips
  // to `done`.
  //
  // Avoid duplicates if the user navigates back and resubmits — reuse
  // the existing one when a CMO audit task is already present.
  const { buildOnboardingBrief } = await import("./cmo-task-brief");
  const { listTasks, createTask } = await import("@/server/db/tasks");
  const { agentNameFor } = await import("@/server/agent-templates");
  const cmoAgentId = agentNameFor(project_slug, "cmo");
  const allTasks = listTasks(project_slug);
  const existingAudit = allTasks.find(
    (t) => t.agent_id === cmoAgentId && t.title?.startsWith("Audit the account"),
  );
  let task = existingAudit;
  if (!task) {
    // Find the project-onboarding task to gate on. Match by exact title
    // (createProjectForOnboardingAction uses a fixed string from
    // buildProjectOnboardingBrief). When it's missing or already terminal,
    // createTask drops the blocker automatically — the audit runs
    // immediately in that case.
    const onboardingTask = allTasks.find(
      (t) =>
        t.agent_id === cmoAgentId &&
        t.title === "Learn the project and write PROJECT.md",
    );

    const { title, brief, success_criteria } = buildOnboardingBrief({
      project_slug,
      project_display_name: updated.display_name,
      google_ads_account_id: match.id,
    });
    task = createTask({
      project_slug,
      agent_id: cmoAgentId,
      title,
      brief,
      success_criteria,
      assigner_agent_id: null,
      status: "proposed",
      blocked_by_task_id: onboardingTask?.id ?? null,
    });
  }

  // Status now:
  //   - If onboarding task was non-terminal at createTask time → audit is
  //     `blocked`. The propagation hook in handleTaskStatus picks it up
  //     when onboarding flips to `done`.
  //   - Otherwise → audit is `proposed`. The task workspace the caller
  //     redirects the user to auto-fires the kickoff client-side via
  //     /api/chat (which atomically claims). For the resubmit branch
  //     (audit already running/done) /api/chat is a safe no-op.

  revalidatePath("/", "layout");
  return { ok: true, project: updated, task_display_id: task.display_id };
}
