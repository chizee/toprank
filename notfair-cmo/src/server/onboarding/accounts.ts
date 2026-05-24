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
  | {
      ok: true;
      project: Project;
      task_display_id: string;
      /** URL slug for the CMO so the client can navigate to its tasks
       *  page without recomputing `<role>-<name>` itself. */
      cmo_agent_slug: string;
    }
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
  const { listProjectAgents } = await import("@/server/agent-meta");
  // Resolve the CMO agent by template_key — agent_ids now encode the
  // personal name, so we can't synthesize one from project_slug alone.
  const projectAgents = await listProjectAgents(project_slug);
  const cmo = projectAgents.find((a) => a.template_key === "cmo");
  if (!cmo) {
    return { ok: false, error: "CMO agent has not been provisioned yet." };
  }
  const cmoAgentId = cmo.agent_id;
  const allTasks = listTasks(project_slug);
  const existingAudit = allTasks.find(
    (t) => t.agent_id === cmoAgentId && t.title?.startsWith("Audit the account"),
  );
  // Find the project-onboarding task. Created synchronously by
  // createProjectForOnboardingAction; should always exist by the time
  // the user gets here.
  const onboardingTask = allTasks.find(
    (t) =>
      t.agent_id === cmoAgentId &&
      t.title === "Learn the project and write PROJECT.md",
  );

  let audit = existingAudit;
  if (!audit) {
    // When the onboarding task is missing or already terminal, createTask
    // drops the blocker automatically — the audit runs immediately.
    const { title, brief, success_criteria } = buildOnboardingBrief({
      project_slug,
      project_display_name: updated.display_name,
      google_ads_account_id: match.id,
    });
    audit = createTask({
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

  // Pick the task to surface in the redirect:
  //   - Prefer the onboarding task while it's still non-terminal — that's
  //     what's actually executing; the audit sits blocked behind it.
  //   - Fall back to the audit when onboarding is already done (or never
  //     existed) so the user lands on the running task either way.
  const TERMINAL = new Set(["done", "failed", "cancelled"]);
  const surfaceTask =
    onboardingTask && !TERMINAL.has(onboardingTask.status)
      ? onboardingTask
      : audit;

  revalidatePath("/", "layout");
  return {
    ok: true,
    project: updated,
    task_display_id: surfaceTask.display_id,
    cmo_agent_slug: cmo.slug,
  };
}

export type ProvisioningProgressResult =
  | { ok: true; steps: { key: string; label: string; status: string; error?: string }[]; overall: "running" | "done" | "failed" }
  | { ok: false; error: string };

/**
 * Poll endpoint for the onboarding "Setting up your agents…" screen.
 * Returns the live per-template provisioning checklist published by
 * `ensureProjectAgents`. The client polls this every ~500ms while the
 * user watches each row flip from pending → in_progress → done.
 *
 * Falls back to a synthesized "done" view when the in-memory progress
 * map is empty AND the agents already exist on disk (cold-start path
 * for users who navigate back to the setup URL after provisioning
 * completed in a prior request).
 */
export async function getProvisioningProgressAction(
  project_slug: string,
): Promise<ProvisioningProgressResult> {
  if (!project_slug.trim()) {
    return { ok: false, error: "Missing project slug." };
  }
  const project = getProject(project_slug);
  if (!project) return { ok: false, error: "Project not found." };

  const { getProgress } = await import("./provisioning-progress");
  const progress = getProgress(project_slug);
  if (progress) {
    return { ok: true, steps: progress.steps, overall: progress.overall };
  }
  // Cold-start: no progress record (process restart between provisioning
  // and the user hitting this screen). Treat as done so the screen
  // proceeds to redirect instead of hanging.
  return {
    ok: true,
    steps: [
      { key: "cmo", label: "Setting up CMO", status: "done" },
      { key: "google_ads", label: "Setting up Google Ads specialist", status: "done" },
      { key: "gateway", label: "Connecting agents to gateway", status: "done" },
    ],
    overall: "done",
  };
}

export type OnboardingReadyResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Block until the project's agents are fully provisioned AND the gateway's
 * runtime snapshot has surfaced them. Called by the onboarding "connect or
 * skip" screen so the user never sees a Connect/Skip button before the
 * agent is ready to receive its first chat.send — without this, clicking
 * Skip immediately after creating a project races the
 * `openclaw agents add` config write and the kickoff fails with
 * INVALID_REQUEST "Agent '<id>' no longer exists in configuration".
 *
 * 30-second ceiling matches the worst-case provisioning + gateway-wait
 * we've observed in dev. Returns ok=false on timeout so the UI can show
 * a retry-friendly error instead of hanging forever.
 */
export async function awaitOnboardingReadyAction(
  project_slug: string,
): Promise<OnboardingReadyResult> {
  if (!project_slug.trim()) {
    return { ok: false, error: "Missing project slug." };
  }
  const project = getProject(project_slug);
  if (!project) return { ok: false, error: "Project not found." };

  const { awaitProvisioning } = await import("./provisioning-state");
  const ready = await awaitProvisioning(project_slug, 30_000);
  if (ready.kind === "timeout") {
    return {
      ok: false,
      error: "Setting up your agents is taking longer than expected. Refresh to retry.",
    };
  }
  if (ready.kind === "no-agents") {
    return {
      ok: false,
      error: "Agent provisioning hasn't started for this project.",
    };
  }
  return { ok: true };
}

export type SkipAccountResult =
  | { ok: true; task_display_id: string; cmo_agent_slug: string }
  | { ok: false; error: string };

/**
 * Skip-Google-Ads variant of the onboarding finish. Resolves the CMO agent
 * and its already-created "Learn the project and write PROJECT.md" task so
 * the client can land the user on the same task workspace the connect path
 * lands on. No account is persisted, no audit task is minted — the audit
 * task is only meaningful once Google Ads is wired up, and the user can
 * always reach the connect screen later from /connections.
 *
 * Blocks until provisioning has fully resolved — `ensureProjectAgents`
 * itself waits for the gateway's runtime config to surface the new agent
 * ids — so by the time the redirect fires, the agent is registered AND
 * the gateway sees it. Without this, the kickoff (server-side via
 * startTaskIfProposed OR client-side via /api/chat) can outrun the
 * `openclaw agents add` config rewrite and fail with INVALID_REQUEST
 * "Agent '<id>' no longer exists in configuration".
 */
export async function getOnboardingTaskForSkipAction(
  project_slug: string,
): Promise<SkipAccountResult> {
  if (!project_slug.trim()) {
    return { ok: false, error: "Missing project slug." };
  }
  const project = getProject(project_slug);
  if (!project) return { ok: false, error: "Project not found." };

  const { awaitProvisioning } = await import("./provisioning-state");
  const ready = await awaitProvisioning(project_slug, 30_000);
  if (ready.kind === "timeout") {
    return {
      ok: false,
      error: "Setting up your agents is taking longer than expected. Try again in a moment.",
    };
  }
  if (ready.kind === "no-agents") {
    return {
      ok: false,
      error: "Agent provisioning hasn't started for this project.",
    };
  }

  const { listTasks } = await import("@/server/db/tasks");
  const { listProjectAgents } = await import("@/server/agent-meta");
  const projectAgents = await listProjectAgents(project_slug);
  const cmo = projectAgents.find((a) => a.template_key === "cmo");
  if (!cmo) {
    return { ok: false, error: "CMO agent has not been provisioned yet." };
  }
  const onboardingTask = listTasks(project_slug).find(
    (t) =>
      t.agent_id === cmo.agent_id &&
      t.title === "Learn the project and write PROJECT.md",
  );
  if (!onboardingTask) {
    return { ok: false, error: "Onboarding task not found." };
  }
  return {
    ok: true,
    task_display_id: onboardingTask.display_id,
    cmo_agent_slug: cmo.slug,
  };
}
