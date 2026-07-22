"use client";

import { useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ChevronRight,
  MessageCircle,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";

import { Markdown } from "@/components/markdown";
import { brandDomain } from "@/components/mcp-icon";
import { cn } from "@/lib/utils";
import {
  humanizeTool,
  iconForTool,
  looksLikeShellInvocation,
  matchMcpServerKey,
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
  const lastDone = [...tools].reverse().find((t) => t.done);
  const hasError = !!(lastDone && !lastDone.ok);
  const headline = representativeTool(tools);
  const headMcp = headline
    ? matchMcpServerKey(headline.name, mcpCatalog)
    : null;
  const HeadIcon = headline ? iconForSummary(headline) : Wrench;
  const summaryLabel = summarizeTools(tools);
  const statusLabel = isLive ? "Running" : hasError ? "Failed" : "Complete";

  return (
    <details
      data-activity-kind={headMcp ? "mcp" : "tool"}
      className="group/details"
    >
      <summary
        className={cn(
          "group/summary flex min-h-8 cursor-pointer list-none select-none items-center gap-2 py-0.5 text-[15px] leading-6",
          "text-[hsl(var(--notfair-ink-3))] focus-visible:outline-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {headMcp ? (
            <ToolBrandFavicon
              resourceUrl={headMcp.resource_url}
              alt={headMcp.display_name}
            />
          ) : (
            <HeadIcon className="size-4" aria-hidden />
          )}
        </span>
        <span
          data-tool-summary
          className={cn(
            "min-w-0 truncate",
            isLive && "ns-shimmer-text",
          )}
        >
          {summaryLabel}
        </span>
        <ChevronRight
          data-tool-toggle
          className="size-4 shrink-0 opacity-0 transition-[transform,opacity] group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100 group-open/details:rotate-90 group-open/details:opacity-100"
          aria-hidden
        />
        <span className="sr-only">{statusLabel}</span>
      </summary>
      <div
        data-tool-list
        className="mt-1 max-h-64 overflow-y-auto overscroll-contain text-[15px] leading-6 text-[hsl(var(--notfair-ink-3))]"
      >
        {tools.map((t, index) => (
          <ToolRow
            key={`${t.toolCallId}:${index}`}
            entry={t}
            mcpCatalog={mcpCatalog}
          />
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
  const Icon = iconForActivity(entry);
  const rowLabel = formatActivityLabel(intent.verb, intent.target);
  const statusLabel = !entry.done
    ? "Running"
    : entry.ok
      ? "Complete"
      : "Failed";

  return (
    <div
      data-tool-row
      data-tool-status={statusLabel.toLowerCase()}
      className="flex min-h-7 items-center gap-2 py-0.5"
      title={entry.label ?? rowLabel}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {mcp ? (
          <ToolBrandFavicon
            resourceUrl={mcp.resource_url}
            alt={mcp.display_name}
          />
        ) : (
          <Icon className="size-4" aria-hidden />
        )}
      </span>
      <span className="min-w-0 truncate">{rowLabel}</span>
      <span className="sr-only">{statusLabel}</span>
    </div>
  );
}

type ActivityCategory = "edit" | "read" | "command" | "other";

function activityCategory(entry: ToolEntry): ActivityCategory {
  const name = entry.name.toLowerCase();
  if (name === "write" || name === "edit" || name === "patch") return "edit";
  if (name === "read" || name === "cat" || name === "open") return "read";
  if (
    name === "shell" ||
    name === "bash" ||
    name === "exec" ||
    looksLikeShellInvocation(entry.name) ||
    looksLikeShellInvocation(entry.label ?? "")
  ) {
    return "command";
  }
  return "other";
}

/**
 * Use the same quiet, category-level summary as the reference transcript:
 * "Edited files, read files, ran commands" rather than a tool count.
 */
function summarizeTools(tools: ToolEntry[]): string {
  if (tools.length === 0) return "Tool activity";
  const phrases: string[] = [];
  const editCount = tools.filter(
    (tool) => activityCategory(tool) === "edit",
  ).length;
  const readCount = tools.filter(
    (tool) => activityCategory(tool) === "read",
  ).length;
  const commandCount = tools.filter(
    (tool) => activityCategory(tool) === "command",
  ).length;

  if (editCount > 0)
    phrases.push(editCount === 1 ? "Edited file" : "Edited files");
  if (readCount > 0)
    phrases.push(readCount === 1 ? "Read file" : "Read files");
  if (commandCount > 0)
    phrases.push(commandCount === 1 ? "Ran command" : "Ran commands");

  for (const tool of tools) {
    if (activityCategory(tool) !== "other") continue;
    const verb = humanizeTool(tool.name, tool.label).verb;
    if (!phrases.some((phrase) => phrase.toLowerCase() === verb.toLowerCase())) {
      phrases.push(verb);
    }
  }

  return phrases
    .map((phrase, index) =>
      index === 0 ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1),
    )
    .join(", ");
}

function representativeTool(tools: ToolEntry[]): ToolEntry | null {
  for (const category of ["edit", "read", "command", "other"] as const) {
    const match = tools.find((tool) => activityCategory(tool) === category);
    if (match) return match;
  }
  return null;
}

function iconForActivity(entry: ToolEntry) {
  const verb = humanizeTool(entry.name, entry.label).verb.toLowerCase();
  if (verb.startsWith("searched")) return Search;
  if (verb.startsWith("read")) return BookOpen;
  return iconForTool(entry.name);
}

function iconForSummary(entry: ToolEntry) {
  const category = activityCategory(entry);
  if (category === "read") return BookOpen;
  if (category === "command") return Terminal;
  return iconForActivity(entry);
}

function formatActivityLabel(verb: string, target?: string): string {
  if (!target) return verb;
  // The intent already supplies the noun through the target, so avoid
  // stilted rows such as "Read file DESIGN.md".
  const compactVerb = verb.replace(/\s+(?:file|url)$/i, "");
  return `${compactVerb} ${target}`;
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
