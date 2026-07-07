"use client";

import { useState } from "react";
import { Plug } from "lucide-react";

/**
 * NotFair-hosted platform MCPs all live on `notfair.co`, so the favicon
 * heuristic below would render the NotFair mark for every one of them.
 * Map each `/api/mcp/<platform>` path to the actual platform's logo
 * (bundled under `public/mcp-logos/`) so the row reads as the platform
 * the user is connecting, not the host serving it.
 */
const PLATFORM_LOGO_BY_MCP_PATH: Record<string, string> = {
  google_ads: "/mcp-logos/google-ads-icon.svg",
  meta_ads: "/mcp-logos/meta-icon.svg",
  google_search_console: "/mcp-logos/search-console-icon.svg",
  google_analytics: "/mcp-logos/google-analytics-icon.svg",
  x_ads: "/mcp-logos/x-ads-icon.svg",
};

/**
 * Local platform-logo path for a NotFair-hosted MCP resource URL, or
 * null when the URL isn't a `notfair.co/api/mcp/<platform>` resource
 * (user-added servers, third-party connectors → favicon fallback).
 */
export function platformLogoForResourceUrl(resourceUrl: string): string | null {
  try {
    const url = new URL(resourceUrl);
    if (brandDomain(url.hostname) !== "notfair.co") return null;
    const match = url.pathname.match(/^\/api\/mcp\/([a-z0-9_]+)\/?$/);
    if (!match) return null;
    return PLATFORM_LOGO_BY_MCP_PATH[match[1]!] ?? null;
  } catch {
    return null;
  }
}

/**
 * Brand icon for an MCP server. NotFair-hosted platform MCPs render the
 * bundled platform logo (Google Ads, Meta, …); everything else falls
 * back to the brand favicon fetched via Google's `faviconV2` service.
 * Subdomain-aware: `mcp.stripe.com` resolves to `stripe.com` so we get
 * the company brand mark, not the API-subdomain glyph (which usually
 * isn't indexed).
 *
 * Falls back to the `Plug` lucide icon on malformed input or image
 * load failure.
 */
export function McpIcon({
  resourceUrl,
  alt,
  size = "md",
}: {
  resourceUrl: string;
  alt: string;
  size?: "md" | "lg";
}) {
  const [errored, setErrored] = useState(false);
  let host: string | null = null;
  try {
    host = new URL(resourceUrl).hostname;
  } catch {
    host = null;
  }
  const platformLogo = platformLogoForResourceUrl(resourceUrl);
  const brandHost = host ? brandDomain(host) : null;
  const showImg = !!(platformLogo ?? brandHost) && !errored;
  const boxClass = size === "lg" ? "size-10" : "size-9";
  const imgClass = size === "lg" ? "size-6" : "size-5";
  const fallbackClass = size === "lg" ? "size-5" : "size-4";
  return (
    <div
      className={`flex ${boxClass} shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted`}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={
            platformLogo ??
            `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${brandHost}&size=32`
          }
          alt={alt}
          width={32}
          height={32}
          className={imgClass}
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
        />
      ) : (
        <Plug className={fallbackClass} />
      )}
    </div>
  );
}

/**
 * Reduce a hostname to its registrable brand domain
 * (`mcp.stripe.com` → `stripe.com`). Simple last-2-labels heuristic;
 * wrong for `.co.uk` and friends, but right for ~all consumer SaaS the
 * connections page targets, and `faviconV2`'s `fallback_opts` cushions
 * the rest.
 */
export function brandDomain(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}
