import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { getProject } from "@/server/db/projects";
import { MCP_CATALOG, storedMcpKey } from "@/server/mcp-catalog";
import { getMcpStatus } from "@/server/mcp-state";
import { summarizeBuiltinTools } from "@/server/mcp-server/tool-summaries";
import { McpCard } from "@/components/mcp-card";
import { BuiltinMcpCard } from "@/components/builtin-mcp-card";
import { McpFlashBanner } from "@/components/mcp-flash-banner";

type Search = { mcp_connected?: string; mcp_error?: string };

export default async function ConnectionsPage({
  searchParams,
  params,
}: {
  searchParams: Promise<Search>;
  params: Promise<{ project: string }>;
}) {
  const { project: slug } = await params;
  const project = getProject(slug);
  const { mcp_connected, mcp_error } = await searchParams;
  if (!project || project.archived_at) notFound();

  // Status probes happen in parallel — each has its own 2s timeout so a
  // flaky upstream doesn't gate the whole page.
  const statuses = await Promise.all(
    MCP_CATALOG.map((s) => getMcpStatus(storedMcpKey(project.slug, s.key))),
  );

  // Built-in MCP: notfair-orchestration ships with the platform and serves
  // every agent without OAuth or setup. We hand its tool summary straight
  // to the card so the tools dialog opens with zero RPC delay.
  const builtinTools = summarizeBuiltinTools();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          MCP Connections
        </h1>
        <p className="text-sm text-muted-foreground">
          MCPs are the tool servers your agents call into. Connect external
          ones (Google Ads, etc.) with one click, or browse the orchestration
          tools that ship built-in.
        </p>
      </header>

      <McpFlashBanner connected={mcp_connected} error={mcp_error} />

      <div className="space-y-3">
        <BuiltinMcpCard
          name="Orchestration"
          description="Built-in tools your agents use to coordinate: assign tasks, request approvals, write PROJECT.md, comment, and report status."
          tools={builtinTools}
        />

        {MCP_CATALOG.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No external MCP servers in the catalog yet.
            </CardContent>
          </Card>
        ) : (
          MCP_CATALOG.map((spec, i) => (
            <McpCard key={spec.key} spec={spec} status={statuses[i]} />
          ))
        )}
      </div>
    </div>
  );
}
