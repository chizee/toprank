/**
 * Static catalog of MCP servers the notfair-cmo UI knows how to connect.
 *
 * "Known" means we have a stable URL + OAuth discovery doc the server-side
 * connect flow can drive end-to-end with zero LLM in the loop. Arbitrary
 * MCPs (user describes one in chat) still go through the agent — the
 * catalog is just the fast path for the ones we ship with.
 *
 * MCPs are managed at the project level (the Connections page). All agents
 * inside a given project share the same MCP rows; cross-project boundaries
 * are enforced by OpenClaw's `codex.agents` allowlist (see docs:
 * gateway/configuration-reference#mcp) which `actions/mcp.ts` populates
 * with every agent id in the active project.
 */

export type McpSpec = {
  /** OpenClaw mcp config key (used by `openclaw mcp show/set/unset`). */
  key: string;
  display_name: string;
  description: string;
  /** Resource URL the token authenticates against (RFC 8707 audience). */
  resource_url: string;
  /** RFC 9728 protected-resource discovery endpoint. */
  discovery_url: string;
};

export const MCP_CATALOG: McpSpec[] = [
  {
    key: "notfair-googleads",
    display_name: "NotFair Google Ads",
    description:
      "Live Google Ads operations: campaigns, bids, budgets, keywords, search terms, change history.",
    resource_url: "https://notfair.co/api/mcp/google_ads",
    discovery_url:
      "https://notfair.co/.well-known/oauth-protected-resource/api/mcp/google_ads",
  },
];

export function mcpSpecByKey(key: string): McpSpec | undefined {
  return MCP_CATALOG.find((m) => m.key === key);
}

/**
 * OpenClaw's mcp config is workspace-global. To keep projects' tokens
 * independent (so connecting an MCP from project A doesn't stomp project
 * B's bearer), we namespace the stored openclaw key with the project
 * slug. Catalog key `notfair-googleads` + project `notfairco` becomes
 * stored key `notfairco-notfair-googleads`. Runtime visibility is still
 * gated by `codex.agents`.
 */
export function storedMcpKey(project_slug: string, catalog_key: string): string {
  return `${project_slug}-${catalog_key}`;
}
