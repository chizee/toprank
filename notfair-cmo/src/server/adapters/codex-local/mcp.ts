import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpRegistrationSpec } from "../types";

/**
 * Per-agent MCP wiring for Codex.
 *
 * Codex reads MCP servers from `~/.codex/config.toml`. notfair-cmo wants
 * project-scoped tokens, but codex's MCP config is global, so we namespace
 * server names with the agent id: `<serverName>__<agentId>`. The
 * orchestration MCP that needs to know the agent context can read that.
 *
 * We rewrite the [mcp_servers.*] sections under our namespace prefix; we
 * never touch user-installed servers outside our prefix.
 */
function codexConfigDir(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function codexConfigPath(): string {
  return join(codexConfigDir(), "config.toml");
}

const NOTFAIR_NS = "notfair_";

function namespaced(serverName: string, agentId: string): string {
  return `${NOTFAIR_NS}${agentId.replace(/-/g, "_")}__${serverName.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

async function readConfig(): Promise<string> {
  const path = codexConfigPath();
  if (!existsSync(path)) return "";
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function stripSection(toml: string, sectionHeader: string): string {
  // Remove a [mcp_servers."x"] block plus its key/value lines until the next
  // section header or EOF. Best-effort regex — codex's TOML is well-formed
  // and we only ever write what we wrote.
  const re = new RegExp(
    `\\n*\\[${escapeRe(sectionHeader)}\\][\\s\\S]*?(?=\\n\\[|\\n*$)`,
    "g",
  );
  return toml.replace(re, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Each codex MCP registration gets its OWN env var name carrying its
 * bearer. Encodes the server name into the env so different MCPs in the
 * same agent's config (orchestration, Google Ads, GSC, ...) can carry
 * different bearers. The spawn site (execute.ts) iterates the project's
 * `mcp_tokens` table + the orchestration secret and injects matching
 * env vars before invoking codex.
 *
 * Why env vars and not literal headers: codex 0.132+ marks raw
 * `headers = { Authorization = "Bearer ..." }` rows as Auth: Unsupported
 * and refuses to expose those MCP tools. The `bearer_token_env_var`
 * path is the documented way.
 */
export function bearerEnvVarForServer(serverName: string): string {
  // Orchestration kept on its dedicated, well-known env var so older
  // configs written before per-server env vars existed keep working.
  if (serverName === "notfair-orchestration") {
    return CODEX_BEARER_ENV_VAR;
  }
  const safe = serverName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `NOTFAIR_MCP_BEARER__${safe}`;
}

/**
 * Dedicated env var for the notfair-orchestration MCP. Kept distinct
 * from the generic `NOTFAIR_MCP_BEARER__*` scheme so existing
 * `~/.codex/config.toml` entries written before per-server env vars
 * existed keep authenticating without a forced re-registration.
 */
export const CODEX_BEARER_ENV_VAR = "NOTFAIR_ORCHESTRATION_BEARER";

function renderServer(spec: McpRegistrationSpec): string {
  const header = `[mcp_servers.${namespaced(spec.serverName, spec.agentId)}]`;
  if (spec.transport.type === "stdio") {
    const lines = [
      header,
      `command = ${JSON.stringify(spec.transport.command)}`,
      `args = ${JSON.stringify(spec.transport.args)}`,
    ];
    if (spec.transport.env) {
      lines.push(`env = ${tomlInlineTable(spec.transport.env)}`);
    }
    return lines.join("\n") + "\n";
  }
  const lines = [header, `url = ${JSON.stringify(spec.transport.url)}`];
  const rawAuth =
    spec.transport.headers?.Authorization ??
    spec.transport.headers?.authorization;
  if (rawAuth) {
    lines.push(
      `bearer_token_env_var = ${JSON.stringify(bearerEnvVarForServer(spec.serverName))}`,
    );
  }
  const otherHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.transport.headers ?? {})) {
    if (k.toLowerCase() !== "authorization") otherHeaders[k] = v;
  }
  if (Object.keys(otherHeaders).length > 0) {
    lines.push(`headers = ${tomlInlineTable(otherHeaders)}`);
  }
  return lines.join("\n") + "\n";
}

function tomlInlineTable(record: Record<string, string>): string {
  const parts = Object.entries(record).map(
    ([k, v]) => `${k} = ${JSON.stringify(v)}`,
  );
  return `{ ${parts.join(", ")} }`;
}

export async function registerCodexMcp(spec: McpRegistrationSpec): Promise<void> {
  await mkdir(codexConfigDir(), { recursive: true });
  let toml = await readConfig();
  toml = stripSection(toml, `mcp_servers.${namespaced(spec.serverName, spec.agentId)}`);
  toml = toml.trimEnd() + "\n\n" + renderServer(spec);
  await writeFile(codexConfigPath(), toml.trimStart(), "utf8");
}

export async function unregisterCodexMcp(
  serverName: string,
  agentId: string,
): Promise<void> {
  let toml = await readConfig();
  if (!toml) return;
  toml = stripSection(toml, `mcp_servers.${namespaced(serverName, agentId)}`);
  await writeFile(codexConfigPath(), toml.trimStart(), "utf8");
}
