"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Plug, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { startMcpConnect } from "@/server/actions/mcp";
import type { McpRuntimeStatus } from "@/server/mcp-state";
import { projectHref } from "@/lib/project-href";

type Props = {
  status: McpRuntimeStatus;
  projectSlug: string;
};

/**
 * Shown above the chat for the Google Ads agent when the notfair-googleads
 * MCP isn't usable yet. The Connect button kicks off the same OAuth flow as
 * the Connections page, but threads the current chat URL through as
 * `return_to` so the user lands back here on success.
 */
export function GoogleAdsMcpBanner({ status, projectSlug }: Props) {
  const [busy, setBusy] = useState(false);

  if (status.state === "connected") return null;

  const isStale = status.state === "stale_token";
  const isUnreachable = status.state === "unreachable";

  async function onConnect() {
    setBusy(true);
    try {
      // Captured at click time (vs. via useSearchParams) so we don't pull in
      // a hook that would force a Suspense boundary in the page above us.
      const return_to = window.location.pathname + window.location.search;
      const result = await startMcpConnect({
        mcp_key: "notfair-googleads",
        return_to,
      });
      if (!result.ok) {
        toast.error(result.error);
        setBusy(false);
        return;
      }
      // Cross-origin redirect: leave the SPA and head to the issuer.
      window.location.href = result.authorize_url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const { headline, detail, action } = copyFor(status);

  return (
    <div
      className="border-b bg-amber-50 px-6 py-3 dark:bg-amber-950/30"
      role="status"
    >
      <div className="mx-auto flex w-full max-w-3xl items-start gap-3">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
          {isStale || isUnreachable ? (
            <AlertTriangle className="size-4" />
          ) : (
            <Plug className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-amber-900 dark:text-amber-100">
            {headline}
          </div>
          <p className="mt-0.5 text-xs text-amber-900/80 dark:text-amber-100/80">
            {detail}{" "}
            <Link
              href={projectHref(projectSlug, "/connections")}
              className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-50"
            >
              Manage connections
            </Link>
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={onConnect}
          disabled={busy}
          className="shrink-0"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plug className="size-3.5" />
          )}
          {action}
        </Button>
      </div>
    </div>
  );
}

function copyFor(status: McpRuntimeStatus): {
  headline: string;
  detail: string;
  action: string;
} {
  switch (status.state) {
    case "stale_token":
      return {
        headline: "Google Ads connection expired",
        action: "Reconnect",
        detail:
          "The NotFair Google Ads token was rejected. Reconnect to resume live account operations.",
      };
    case "unreachable":
      return {
        headline: "Google Ads connection is unreachable",
        action: "Reconnect",
        detail:
          "Couldn't reach the NotFair Google Ads MCP. The agent will run blind until this is restored.",
      };
    case "configured_no_token":
      return {
        headline: "Google Ads MCP needs a token",
        action: "Connect",
        detail:
          "Connect to enable live campaign, keyword, bid, and budget operations against your account.",
      };
    case "not_configured":
    default:
      return {
        headline: "Connect NotFair Google Ads to go live",
        action: "Connect",
        detail:
          "Connect the MCP to let this agent run campaigns, manage keywords, and pull real metrics from your account.",
      };
  }
}
