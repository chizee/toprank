"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plug,
  Loader2,
  Unplug,
  BookOpenText,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  startMcpConnect,
  disconnectMcpAction,
  listMcpToolsAction,
  removeUserMcpServerAction,
} from "@/server/actions/mcp";
import type { McpSpec } from "@/server/mcp-catalog";
import type { McpRuntimeStatus } from "@/server/mcp/state";
import { McpToolsDialog } from "@/components/mcp-tools-dialog";
import { McpIcon } from "@/components/mcp-icon";

type Props = {
  spec: McpSpec;
  status: McpRuntimeStatus;
};

/**
 * One row in the Connections list. Drops the outer Card border because
 * the parent `<ol>` provides a single shared container + dividers; this
 * keeps the visual rhythm of a refined editorial list rather than a
 * stack of disconnected boxes.
 */
export function McpCard({ spec, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"connect" | "disconnect" | "remove" | null>(
    null,
  );
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
        router.refresh();
      }
      setBusy(null);
    });
  }

  function onRemove() {
    setBusy("remove");
    startTransition(async () => {
      const result = await removeUserMcpServerAction({ mcp_key: spec.key });
      if (!result.ok) {
        toast.error(result.error);
      } else {
        toast.success(`${spec.display_name} removed`);
        router.refresh();
      }
      setBusy(null);
    });
  }

  const isBusy = busy !== null || pending;
  const canViewTools = status.state === "connected";
  // Every connector is removable now — presets get hidden per-project
  // via the hidden_mcp_preset_keys list; user rows get deleted. Either
  // way the card disappears from the connections list.
  const canRemove = true;

  return (
    <>
      <article className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/30">
        <McpIcon
          resourceUrl={spec.resource_url}
          alt={spec.display_name}
          size="lg"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium tracking-tight">
              {spec.display_name}
            </h3>
            <StatusDot status={status} />
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {spec.description}
          </p>
          <StatusLine status={status} resourceUrl={spec.resource_url} />
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {canViewTools && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setToolsOpen(true)}
            >
              <BookOpenText className="size-3.5" />
              Tools
            </Button>
          )}
          {canRemove && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"
              disabled={isBusy}
              onClick={onRemove}
              aria-label={`Remove ${spec.display_name}`}
              title="Remove server"
            >
              {busy === "remove" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </Button>
          )}
          {status.state === "connected" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
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
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={isBusy}
              onClick={onConnect}
            >
              {busy === "connect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plug className="size-3.5" />
              )}
              {status.state === "stale_token" ? "Reconnect" : "Connect"}
            </Button>
          )}
        </div>
      </article>

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

/**
 * Inline status indicator — a small filled dot next to the name. Color
 * carries the state, no background pill needed.
 */
function StatusDot({ status }: { status: McpRuntimeStatus }) {
  const map: Record<McpRuntimeStatus["state"], { color: string; label: string }> =
    {
      connected: { color: "bg-emerald-500", label: "connected" },
      stale_token: { color: "bg-amber-500", label: "token expired" },
      unreachable: { color: "bg-destructive", label: "unreachable" },
      configured_no_token: { color: "bg-amber-500", label: "no token" },
      not_configured: { color: "bg-muted-foreground/40", label: "not connected" },
    };
  const { color, label } = map[status.state];
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
      role="status"
    >
      <span className={`size-1.5 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}

/**
 * Bottom metadata line: brand host (mono small) plus connection-state
 * details (verified Xm ago, error blurb, etc.) separated by a thin dot.
 */
function StatusLine({
  status,
  resourceUrl,
}: {
  status: McpRuntimeStatus;
  resourceUrl: string;
}) {
  const host = (() => {
    try {
      return new URL(resourceUrl).host;
    } catch {
      return resourceUrl;
    }
  })();
  const detail = describeStatus(status);
  return (
    <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/80">
      <span>{host}</span>
      {detail ? (
        <>
          <span className="mx-1.5 text-muted-foreground/40">·</span>
          <span>{detail}</span>
        </>
      ) : null}
    </p>
  );
}

function describeStatus(status: McpRuntimeStatus): string | null {
  switch (status.state) {
    case "connected":
      return `live · verified ${timeAgo(status.last_checked_at)}`;
    case "stale_token":
      return `token rejected (HTTP ${status.http_status})`;
    case "unreachable":
      return status.error;
    case "configured_no_token":
      return "config saved, awaiting bearer";
    case "not_configured":
      return "one-click OAuth saves the token locally";
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}
