import { notFound } from "next/navigation";
import { getProject } from "@/server/db/projects";
import { getMcpCatalog } from "@/server/mcp-catalog";
import { getMcpStatus } from "@/server/mcp/state";
import { summarizeBuiltinTools } from "@/server/mcp-server/tool-summaries";
import { McpCard } from "@/components/mcp-card";
import { BuiltinMcpCard } from "@/components/builtin-mcp-card";
import { McpFlashBanner } from "@/components/mcp-flash-banner";
import { AddMcpServerMenu } from "@/components/add-mcp-server-card";
import { normalizeResourceUrl } from "@/server/mcp/discovery-url";

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

  const catalog = getMcpCatalog(project.slug);
  // Status probes happen in parallel — each has its own 2s timeout so a
  // flaky upstream doesn't gate the whole page.
  const statuses = await Promise.all(
    catalog.map((s) => getMcpStatus(project.slug, s.key)),
  );

  const builtinTools = summarizeBuiltinTools();
  const connectedCount = statuses.filter((s) => s.state === "connected").length;
  // Used by the Browse-connectors dialog to render already-connected
  // tiles as non-clickable "connected" pills. We pass both keys *and*
  // normalized resource URLs because the trusted-connector id and the
  // stored mcp_tokens.server_name don't always match (e.g. NotFair Meta
  // Ads was historically slugified to `notfair-meta-ads` while the tile
  // uses canonical id `notfair-metaads`). The URL is the stable signal.
  const connectedSpecs = catalog.filter(
    (_, i) => statuses[i].state === "connected",
  );
  const connectedKeys = connectedSpecs.map((s) => s.key);
  const connectedResourceUrls = connectedSpecs.map((s) =>
    normalizeResourceUrl(s.resource_url),
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      {/* Editorial header — eyebrow, large title, sublabel, and the
          primary action lifted into the top-right slot. */}
      <header className="border-b border-border/60 pb-8">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Project · {project.display_name}
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Connections
            </h1>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              MCP servers are the tools your agents call. Browse the curated
              list or paste any OAuth&nbsp;2.0 URL.
            </p>
          </div>
          <div className="shrink-0">
            <AddMcpServerMenu
              connectedKeys={connectedKeys}
              connectedResourceUrls={connectedResourceUrls}
            />
          </div>
        </div>
      </header>

      <McpFlashBanner connected={mcp_connected} error={mcp_error} />

      {/* Built-in section — visually anchored with the orchestration
          accent so users can tell at a glance it's not an external MCP. */}
      <section className="mt-10">
        <SectionHeading
          label="Built-in"
          meta="ships with the platform"
        />
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          <BuiltinMcpCard
            name="Orchestration"
            description="Built-in tools your agents use to coordinate: assign tasks, request approvals, write PROJECT.md, comment, and report status."
            tools={builtinTools}
          />
        </div>
      </section>

      {/* External servers — one list, one container, sharp row dividers. */}
      <section className="mt-10">
        <SectionHeading
          label="Servers"
          meta={
            catalog.length === 0
              ? "none yet"
              : `${connectedCount} of ${catalog.length} connected`
          }
        />
        {catalog.length === 0 ? (
          <div className="mt-3 overflow-hidden rounded-xl border border-dashed border-border bg-card">
            <p className="px-6 py-12 text-center text-sm text-muted-foreground">
              No external MCP servers yet. Use{" "}
              <span className="font-medium text-foreground">Add server</span>{" "}
              above to browse trusted connectors or paste a URL.
            </p>
          </div>
        ) : (
          <ol className="mt-3 overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
            {catalog.map((spec, i) => (
              <li key={spec.key}>
                <McpCard spec={spec} status={statuses[i]} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function SectionHeading({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </h2>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
        {meta}
      </span>
    </div>
  );
}
