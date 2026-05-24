"use client";

import { useState } from "react";
import { Workflow, BookOpenText } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { McpToolsDialog } from "@/components/mcp-tools-dialog";
import type { ToolSummary } from "@/server/mcp-server/tool-summaries";

/**
 * Card for an MCP that ships with notfair-cmo itself — no OAuth, no
 * connect/disconnect, always available to every agent. We distinguish
 * it visually from external OAuth MCPs through:
 *
 *  - icon: `Workflow` (orchestration) instead of `Plug` (external wire)
 *  - badge: "Built-in" emerald chip in place of a connection-state badge
 *  - right-side action: "View tools" only (no Connect button)
 *  - footer line states the tool count + "Self-hosted" instead of a
 *    connection-state detail line
 *
 * Tool list is supplied directly from the server-side describeTool walk
 * so the dialog opens instantly — no RPC roundtrip.
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
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/20">
                <Workflow className="size-4 text-emerald-700 dark:text-emerald-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">{name}</h3>
                  <Badge
                    variant="secondary"
                    className="h-4 gap-1 border-emerald-500/20 bg-emerald-500/10 px-1.5 text-[10px] font-medium tracking-wide text-emerald-700 uppercase dark:text-emerald-400"
                  >
                    Built-in
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {description}
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {tools.length} tool{tools.length === 1 ? "" : "s"} · self-hosted ·
                  no setup
                </p>
              </div>
            </div>
            <div className="shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpen(true)}
              >
                <BookOpenText className="size-3.5" />
                View tools
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

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
