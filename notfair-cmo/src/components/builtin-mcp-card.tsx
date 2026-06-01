"use client";

import { useState } from "react";
import { Workflow, BookOpenText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { McpToolsDialog } from "@/components/mcp-tools-dialog";
import type { ToolSummary } from "@/server/mcp-server/tool-summaries";

/**
 * Row for an MCP that ships with notfair-cmo itself — no OAuth, no
 * connect/disconnect, always available to every agent. Visually
 * distinguished from external rows by an emerald-tinted icon tile and
 * a small "BUILT-IN" lozenge in place of a connection-state badge.
 */
type Props = {
  name: string;
  description: string;
  tools: ToolSummary[];
};

export function BuiltinMcpCard({ name, description, tools }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <article className="flex items-center gap-4 px-5 py-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/25">
          <Workflow className="size-5 text-emerald-700 dark:text-emerald-400" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium tracking-tight">
              {name}
            </h3>
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">
              <span
                className="size-1.5 rounded-full bg-emerald-500"
                aria-hidden
              />
              built-in
            </span>
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {description}
          </p>
          <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/80">
            self-hosted
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            {tools.length} tool{tools.length === 1 ? "" : "s"}
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            no setup
          </p>
        </div>

        <div className="shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setOpen(true)}
          >
            <BookOpenText className="size-3.5" />
            Tools
          </Button>
        </div>
      </article>

      <McpToolsDialog
        open={open}
        onOpenChange={setOpen}
        mcpName={name}
        mcpDescription={description}
        tools={tools}
      />
    </>
  );
}
