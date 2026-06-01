"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plug,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Unplug,
  XCircle,
  BookOpenText,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  startMcpConnect,
  disconnectMcpAction,
  listMcpToolsAction,
} from "@/server/actions/mcp";
import type { McpSpec } from "@/server/mcp-catalog";
import type { McpRuntimeStatus } from "@/server/mcp/state";
import { McpToolsDialog } from "@/components/mcp-tools-dialog";

type Props = {
  spec: McpSpec;
  status: McpRuntimeStatus;
};

export function McpCard({ spec, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const router = useRouter();

  async function onConnect() {
    setBusy("connect");
    try {
      const result = await startMcpConnect({ mcp_key: spec.key });
      if (!result.ok) {
        toast.error(result.error);
        setBusy(null);
        return;
      }
      // Full-page navigation: the authorize URL is on a different origin
      // (the MCP issuer), so we can't push() into Next's router.
      window.location.href = result.authorize_url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  function onDisconnect() {
    setBusy("disconnect");
    startTransition(async () => {
      const result = await disconnectMcpAction({ mcp_key: spec.key });
      if (!result.ok) {
        toast.error(result.error);
      } else {
        toast.success(`${spec.display_name} disconnected`);
        // revalidatePath inside the action invalidates the cached server
        // render, but the client still needs to re-fetch — router.refresh()
        // forces the RSC payload to repopulate this card's `status` prop.
        router.refresh();
      }
      setBusy(null);
    });
  }

  const isBusy = busy !== null || pending;
  const canViewTools = status.state === "connected";

  return (
    <>
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <Plug className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">{spec.display_name}</h3>
                  <StatusBadge status={status} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {spec.description}
                </p>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {spec.resource_url}
                </p>
              </div>
            </div>
            <div className="shrink-0">
              {status.state === "connected" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  onClick={onDisconnect}
                >
                  {busy === "disconnect" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Unplug className="size-3.5" />
                  )}
                  Disconnect
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={isBusy} onClick={onConnect}>
                  {busy === "connect" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Plug className="size-3.5" />
                  )}
                  {status.state === "stale_token" ? "Reconnect" : "Connect"}
                </Button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <StatusDetail status={status} />
            {canViewTools && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setToolsOpen(true)}
              >
                <BookOpenText className="size-3.5" />
                View tools
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <McpToolsDialog
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        mcpName={spec.display_name}
        mcpDescription={spec.description}
        loadTools={() => listMcpToolsAction({ mcp_key: spec.key })}
      />
    </>
  );
}

function StatusBadge({ status }: { status: McpRuntimeStatus }) {
  switch (status.state) {
    case "connected":
      return (
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <CheckCircle2 className="size-3 text-emerald-600" />
          connected
        </Badge>
      );
    case "stale_token":
      return (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <AlertTriangle className="size-3 text-amber-600" />
          token expired
        </Badge>
      );
    case "unreachable":
      return (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <XCircle className="size-3 text-destructive" />
          unreachable
        </Badge>
      );
    case "configured_no_token":
      return (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <AlertTriangle className="size-3 text-amber-600" />
          no token
        </Badge>
      );
    case "not_configured":
      return (
        <Badge variant="outline" className="text-[10px]">
          not connected
        </Badge>
      );
  }
}

function StatusDetail({ status }: { status: McpRuntimeStatus }) {
  switch (status.state) {
    case "connected":
      return (
        <p className="text-xs text-muted-foreground">
          {status.tools_count !== null
            ? `${status.tools_count} tool${status.tools_count === 1 ? "" : "s"} available`
            : "Live."}
          {" · Verified "}
          {timeAgo(status.last_checked_at)}
        </p>
      );
    case "stale_token":
      return (
        <p className="text-xs text-muted-foreground">
          Server rejected the saved token (HTTP {status.http_status}). Reconnect
          to refresh.
        </p>
      );
    case "unreachable":
      return (
        <p className="text-xs text-muted-foreground">
          Couldn’t reach the MCP server: {status.error}
        </p>
      );
    case "configured_no_token":
      return (
        <p className="text-xs text-muted-foreground">
          Config exists but has no bearer token. Click Connect to fix.
        </p>
      );
    case "not_configured":
      return (
        <p className="text-xs text-muted-foreground">
          One click runs the OAuth flow against the issuer and saves the token
          locally to this project.
        </p>
      );
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}
