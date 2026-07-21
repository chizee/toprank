"use client";

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  MessageCircle,
  Wrench,
  XCircle,
} from "lucide-react";

import { Markdown } from "@/components/markdown";
import { brandDomain } from "@/components/mcp-icon";
import { cn } from "@/lib/utils";
import {
  humanizeTool,
  iconForTool,
  matchMcpServerKey,
  formatToolName,
  type McpCatalogEntryLite,
} from "./tool-intent";
import type { RenderedItem, ToolEntry } from "./transcript-model";

/**
 * Presentational chat pieces — no stream state in this file. Styling
 * follows the Claude/ChatGPT chat grammar: user turns are compact
 * right-aligned bubbles, agent turns are unboxed prose, tool activity is
 * a quiet collapsible line between them, and surfaces separate by
 * elevation and tint rather than borders.
 */

export function RenderItem({
  item,
  mcpCatalog,
}: {
  item: RenderedItem;
  mcpCatalog?: McpCatalogEntryLite[];
}) {
  if (item.kind === "user_message") {
    // Platform-generated briefs (goal intake kickoff, tick briefs) are
    // not something the user typed — render a compact system line so the
    // chat reads as "the agent got to work", not "who wrote this?".
    if (item.system) {
      const label = item.body.startsWith("[TICK]")
        ? "Heartbeat tick — brief delivered to the agent"
        : item.body.startsWith("[INTAKE]")
          ? "Goal created — your ambition was handed to the agent"
          : "Scheduled brief delivered to the agent";
      return <SystemLine label={label} />;
    }
    return <UserBubble body={item.body} />;
  }
  if (item.kind === "assistant_text") {
    return <AssistantText body={item.body} />;
  }
  if (item.kind === "tool_group") {
    return <ToolGroup tools={item.tools} mcpCatalog={mcpCatalog} />;
  }
  return null;
}

export function SystemLine({ label }: { label: string }) {
  return (
    <div className="flex justify-center">
      <span className="rounded-full bg-[hsl(var(--notfair-surface-2))] px-3.5 py-1 text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
        {label}
      </span>
    </div>
  );
}

export function UserBubble({ body }: { body: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] rounded-[20px] rounded-br-md bg-[hsl(var(--notfair-surface-2))] px-4 py-2.5 text-[14.5px] leading-relaxed text-foreground/95 shadow-sm whitespace-pre-wrap break-words">
        {body}
      </div>
    </div>
  );
}

export function AssistantText({
  body,
  streaming = false,
}: {
  body: string;
  streaming?: boolean;
}) {
  if (body.trim() === "") return null;
  return (
    <div className="text-[15px] leading-[1.75] text-foreground/95">
      <Markdown>{body}</Markdown>
      {streaming && (
        <span
          aria-hidden
          className="ml-1 inline-block h-[15px] w-[3px] translate-y-[2px] animate-pulse rounded-full bg-foreground/60"
        />
      )}
    </div>
  );
}

export function ToolGroup({
  tools,
  mcpCatalog,
}: {
  tools: ToolEntry[];
  mcpCatalog?: McpCatalogEntryLite[];
}) {
  const inFlightCount = tools.filter((t) => !t.done).length;
  const isLive = inFlightCount > 0;
  const headline = tools.find((t) => !t.done) ?? tools[tools.length - 1] ?? null;
  // Group status reflects the FINAL outcome, not "any error ever". When the
  // agent retried a failed call and the retry succeeded, the user sees
  // green — only expanding the card reveals the intermediate stumble.
  // Matches Claude.ai's pattern of grading by "did this turn ultimately
  // work" rather than punishing every recoverable hiccup.
  const lastDone = [...tools].reverse().find((t) => t.done);
  const hasError = !!(lastDone && !lastDone.ok);
  const intent = headline
    ? humanizeTool(headline.name, headline.label)
    : { verb: "Tool call" };
  const headMcp = headline ? matchMcpServerKey(headline.name, mcpCatalog) : null;
  const HeadIcon = headline ? iconForTool(headline.name) : Wrench;
  const mcpCount = tools.filter((tool) =>
    matchMcpServerKey(tool.name, mcpCatalog),
  ).length;
  const StatusIcon = isLive ? Loader2 : hasError ? XCircle : CheckCircle2;
  const statusClass = isLive
    ? "text-[hsl(var(--notfair-accent))] motion-safe:animate-spin"
    : hasError
      ? "text-destructive"
      : "text-emerald-500";
  const summaryLabel =
    tools.length === 1
      ? intent.verb
      : `${isLive ? "Using" : "Used"} ${tools.length} tools`;

  return (
    <details
      data-activity-kind={headMcp ? "mcp" : "tool"}
      className="group"
    >
      <summary
        className={cn(
          "-mx-2 flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1 text-xs",
          "transition-colors hover:bg-[hsl(var(--notfair-hover))] [&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90" />
        {headMcp ? (
          <ToolBrandFavicon
            resourceUrl={headMcp.resource_url}
            alt={headMcp.display_name}
          />
        ) : (
          <HeadIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "font-medium",
            isLive ? "ns-shimmer-text" : "text-foreground/80",
          )}
        >
          {summaryLabel}
        </span>
        {tools.length === 1 && intent.target && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground/80">
            {intent.target}
          </span>
        )}
        {tools.length === 1 && headMcp && (
          <span className="truncate text-[10.5px] text-muted-foreground/80">
            {headMcp.display_name} MCP
          </span>
        )}
        {tools.length > 1 && mcpCount > 0 && (
          <span className="text-[10.5px] text-muted-foreground/80">
            {mcpCount} MCP {mcpCount === 1 ? "call" : "calls"}
          </span>
        )}
        <StatusIcon className={cn("ml-auto size-3.5 shrink-0", statusClass)} />
      </summary>
      <div className="mt-1.5 divide-y divide-border/30 rounded-xl bg-[hsl(var(--notfair-surface-2)/0.5)] px-3.5 py-1">
        {tools.map((t) => (
          <ToolRow key={t.toolCallId} entry={t} mcpCatalog={mcpCatalog} />
        ))}
      </div>
    </details>
  );
}

function ToolRow({
  entry,
  mcpCatalog,
}: {
  entry: ToolEntry;
  mcpCatalog?: McpCatalogEntryLite[];
}) {
  const intent = humanizeTool(entry.name, entry.label);
  const mcp = matchMcpServerKey(entry.name, mcpCatalog);
  const Icon = iconForTool(entry.name);
  const StatusIcon = entry.done
    ? entry.ok
      ? CheckCircle2
      : XCircle
    : Loader2;
  const statusClass = entry.done
    ? entry.ok
      ? "text-emerald-500"
      : "text-destructive"
    : "text-[hsl(var(--notfair-accent))] motion-safe:animate-spin";
  // Show the raw command/label only when it actually adds information —
  // i.e. it's not redundant with the intent target the header already
  // surfaces (path/url/etc.). Keeps simple tool rows tight while still
  // exposing shell command lines and other raw invocations in full.
  const showRawLabel =
    !!entry.label &&
    entry.label.trim() !== "" &&
    entry.label.trim() !== intent.target?.trim();
  return (
    <div className="space-y-1.5 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <StatusIcon className={cn("size-3.5 shrink-0", statusClass)} />
        <span className="font-medium text-foreground/90">{intent.verb}</span>
        {intent.target && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
            {intent.target}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
          {mcp ? `${mcp.display_name} MCP` : "Local tool"}
        </span>
      </div>
      <div className="ml-5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/60">
        {mcp ? (
          <ToolBrandFavicon resourceUrl={mcp.resource_url} alt={mcp.display_name} />
        ) : (
          <Icon className="size-3 shrink-0" />
        )}
        <span>{formatToolName(entry.name)}</span>
      </div>
      {showRawLabel && (
        <pre className="ml-5 max-h-40 overflow-auto rounded-lg bg-[hsl(var(--notfair-surface-2))] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-foreground/75 whitespace-pre-wrap break-all">
          {entry.label}
        </pre>
      )}
      {entry.done && entry.result && (
        <div className="ml-5 text-[11px] leading-relaxed text-muted-foreground/90">
          <span className="break-words">{entry.result}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Tiny inline favicon for an MCP tool row — sized to fit the same 3.5
 * grid slot as the lucide icons next to it, so MCP and built-in tools
 * align cleanly in the same column.
 */
function ToolBrandFavicon({
  resourceUrl,
  alt,
}: {
  resourceUrl: string;
  alt: string;
}) {
  const [errored, setErrored] = useState(false);
  let host: string | null = null;
  try {
    host = new URL(resourceUrl).hostname;
  } catch {
    host = null;
  }
  const brand = host ? brandDomain(host) : null;
  if (!brand || errored) {
    return <Wrench className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${brand}&size=16`}
      alt={alt}
      width={14}
      height={14}
      className="size-3.5 shrink-0 rounded-[3px]"
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
    />
  );
}

/**
 * Replaces the working indicator when the task is parked in `blocked`.
 * The agent isn't currently running — it's dormant until the gating
 * condition (most often a pending approval) resolves.
 */
export function BlockedStatus({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-[hsl(var(--notfair-warn)/0.1)] px-3.5 py-2.5 text-xs">
      <span
        className="mt-1 inline-block size-2 shrink-0 rounded-full bg-[hsl(var(--notfair-warn))]"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-[hsl(var(--notfair-warn))]">
          Paused — {reason}
        </div>
        <div className="mt-0.5 text-[11px] text-[hsl(var(--notfair-ink-3))]">
          The agent will resume automatically when the gating condition
          resolves. You can also reply below to give context or answer a
          question.
        </div>
      </div>
    </div>
  );
}

export function ErrorRow({
  agentDisplayName,
  body,
}: {
  agentDisplayName: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-destructive/10 px-3.5 py-3 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-destructive">
          Couldn&rsquo;t reach {agentDisplayName}.
        </div>
        <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {body}
        </div>
      </div>
    </div>
  );
}

export function TranscriptEmptyState({
  agentDisplayName,
}: {
  agentDisplayName: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-[hsl(var(--notfair-surface-2))] shadow-sm">
        <MessageCircle
          className="size-5 text-[hsl(var(--notfair-ink-3))]"
          aria-hidden
        />
      </div>
      <div>
        <p className="m-0 text-[14px] font-medium text-foreground/90">
          Chat with {agentDisplayName}
        </p>
        <p className="m-0 mt-1 text-[12.5px] text-muted-foreground">
          Ask about its metric, steer the plan, or hand it new context —
          type <span className="font-mono">/</span> for commands.
        </p>
      </div>
    </div>
  );
}
