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
  | { ok: true; project: Project }
  | { ok: false; error: string };

/**
 * Persist the selected Google Ads customer ID on the project row. Validates
 * the account_id against the MCP's accounts list to prevent the UI from
 * stashing a stale or fabricated id.
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
  revalidatePath("/", "layout");
  return { ok: true, project: updated };
}
