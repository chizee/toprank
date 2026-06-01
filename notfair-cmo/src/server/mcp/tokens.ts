import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db/db";

/**
 * MCP token storage for notfair-cmo.
 *
 * Replaces OpenClaw's config-file storage (`openclaw mcp set/unset`). Tokens
 * are project-scoped — one project's notfair-googleads connection never bleeds
 * into another's.
 *
 * `access_token_enc` / `refresh_token_enc` columns are encrypted-at-rest
 * placeholders today (we store the raw JSON envelope from the OAuth callback)
 * but the schema is ready for a keytar-backed encryption pass.
 */
export interface McpToken {
  id: string;
  project_slug: string;
  server_name: string;
  account_label: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
  scope: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertMcpTokenInput {
  project_slug: string;
  server_name: string;
  account_label?: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
  metadata?: Record<string, unknown>;
}

export function upsertMcpToken(input: UpsertMcpTokenInput): McpToken {
  const db = getDb();
  const account_label = input.account_label ?? "";
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      "SELECT * FROM mcp_tokens WHERE project_slug = ? AND server_name = ? AND account_label = ?",
    )
    .get(input.project_slug, input.server_name, account_label) as McpToken | undefined;

  if (existing) {
    db.prepare(
      "UPDATE mcp_tokens SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, scope = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
    ).run(
      input.access_token,
      input.refresh_token ?? null,
      input.expires_at ?? null,
      input.scope ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      existing.id,
    );
    return getMcpToken(existing.id)!;
  }

  const token: McpToken = {
    id: randomUUID(),
    project_slug: input.project_slug,
    server_name: input.server_name,
    account_label,
    access_token_enc: input.access_token,
    refresh_token_enc: input.refresh_token ?? null,
    expires_at: input.expires_at ?? null,
    scope: input.scope ?? null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    "INSERT INTO mcp_tokens (id, project_slug, server_name, account_label, access_token_enc, refresh_token_enc, expires_at, scope, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    token.id,
    token.project_slug,
    token.server_name,
    token.account_label,
    token.access_token_enc,
    token.refresh_token_enc,
    token.expires_at,
    token.scope,
    token.metadata_json,
    token.created_at,
    token.updated_at,
  );
  return token;
}

export function getMcpToken(id: string): McpToken | null {
  return (
    (getDb()
      .prepare("SELECT * FROM mcp_tokens WHERE id = ?")
      .get(id) as McpToken | undefined) ?? null
  );
}

export function findMcpToken(
  project_slug: string,
  server_name: string,
  account_label = "",
): McpToken | null {
  return (
    (getDb()
      .prepare(
        "SELECT * FROM mcp_tokens WHERE project_slug = ? AND server_name = ? AND account_label = ?",
      )
      .get(project_slug, server_name, account_label) as McpToken | undefined) ?? null
  );
}

export function listProjectMcpTokens(project_slug: string): McpToken[] {
  return getDb()
    .prepare("SELECT * FROM mcp_tokens WHERE project_slug = ? ORDER BY server_name, account_label")
    .all(project_slug) as McpToken[];
}

export function deleteMcpToken(id: string): void {
  getDb().prepare("DELETE FROM mcp_tokens WHERE id = ?").run(id);
}

export function deleteProjectMcpTokens(project_slug: string): void {
  getDb().prepare("DELETE FROM mcp_tokens WHERE project_slug = ?").run(project_slug);
}
