/**
 * Static catalog of MCP servers the notfair-cmo UI knows how to connect.
 *
 * "Known" means we have a stable URL + OAuth discovery doc the server-side
 * connect flow can drive end-to-end with zero LLM in the loop. Arbitrary
 * MCPs (user describes one in chat) still go through the agent — the
 * catalog is just the fast path for the ones we ship with.
 *
 * MCPs are managed at the project level (the Connections page). Tokens live
 * in the `mcp_tokens` SQLite table, scoped by (project_slug, server_name).
 * Per-agent visibility is enforced by the harness adapter's `registerMcp`
 * hook, which writes the chosen agent's MCP config to point at the right
 * token row.
 */

export type McpSpec = {
  /** Stable catalog identifier (used by the UI + mcp_tokens.server_name). */
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
