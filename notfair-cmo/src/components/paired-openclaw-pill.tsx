import { ExternalLink } from "lucide-react";
import { discoverGateway } from "@/server/openclaw/gateway-client";
import { cn } from "@/lib/utils";

/**
 * Sidebar pill that opens the OpenClaw gateway dashboard in a new tab with
 * token-based auto-auth. The token is embedded in the URL fragment (`#token=`)
 * — same mechanism `openclaw dashboard` uses — so it isn't sent to the server
 * in the HTTP request line. We render nothing when the gateway config can't
 * be discovered (rather than a broken-looking pill).
 */
export function PairedOpenclawPill() {
  let dashboardUrl: string | null = null;
  try {
    const gw = discoverGateway();
    // gw.url is ws://host:port — the dashboard lives at the same host:port
    // over http. Token goes in the fragment so it never hits server access
    // logs or HTTP referer headers.
    const httpBase = gw.url.replace(/^ws/, "http");
    dashboardUrl = gw.token
      ? `${httpBase}/#token=${encodeURIComponent(gw.token)}`
      : `${httpBase}/`;
  } catch {
    return null;
  }

  return (
    <a
      href={dashboardUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group inline-flex w-full items-center gap-2 rounded-full",
        "border border-border bg-background px-3 py-1.5",
        "text-xs font-medium text-foreground",
        "transition-colors hover:bg-sidebar-accent",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // In icon-collapsed sidebar, keep the dot visible and hide the label.
        "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2",
      )}
      title="Open OpenClaw dashboard"
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-emerald-500"
      />
      <span className="flex-1 truncate group-data-[collapsible=icon]:hidden">
        Paired OpenClaw
      </span>
      <ExternalLink
        className="size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
        aria-hidden
      />
    </a>
  );
}
