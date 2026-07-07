// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { McpIcon, brandDomain, platformLogoForResourceUrl } from "./mcp-icon";

afterEach(() => {
  cleanup();
});

describe("platformLogoForResourceUrl", () => {
  it("maps every NotFair-hosted platform MCP to its bundled logo", () => {
    expect(
      platformLogoForResourceUrl("https://notfair.co/api/mcp/google_ads"),
    ).toBe("/mcp-logos/google-ads-icon.svg");
    expect(
      platformLogoForResourceUrl("https://notfair.co/api/mcp/meta_ads"),
    ).toBe("/mcp-logos/meta-icon.svg");
    expect(
      platformLogoForResourceUrl(
        "https://notfair.co/api/mcp/google_search_console",
      ),
    ).toBe("/mcp-logos/search-console-icon.svg");
    expect(
      platformLogoForResourceUrl("https://notfair.co/api/mcp/google_analytics"),
    ).toBe("/mcp-logos/google-analytics-icon.svg");
    expect(platformLogoForResourceUrl("https://notfair.co/api/mcp/x_ads")).toBe(
      "/mcp-logos/x-ads-icon.svg",
    );
  });

  it("tolerates a trailing slash and www-style subdomains", () => {
    expect(
      platformLogoForResourceUrl("https://www.notfair.co/api/mcp/google_ads/"),
    ).toBe("/mcp-logos/google-ads-icon.svg");
  });

  it("returns null for third-party servers, unknown platforms, and junk", () => {
    expect(platformLogoForResourceUrl("https://mcp.stripe.com/")).toBeNull();
    expect(
      platformLogoForResourceUrl("https://notfair.co/api/mcp/unknown_platform"),
    ).toBeNull();
    expect(platformLogoForResourceUrl("https://notfair.co/")).toBeNull();
    expect(platformLogoForResourceUrl("not a url")).toBeNull();
  });

  it("does not match notfair.co paths outside /api/mcp/", () => {
    expect(
      platformLogoForResourceUrl("https://notfair.co/blog/google_ads"),
    ).toBeNull();
  });
});

describe("McpIcon", () => {
  it("renders the bundled platform logo for a NotFair platform MCP", () => {
    render(
      <McpIcon
        resourceUrl="https://notfair.co/api/mcp/x_ads"
        alt="NotFair X Ads"
      />,
    );
    expect(screen.getByAltText("NotFair X Ads")).toHaveAttribute(
      "src",
      "/mcp-logos/x-ads-icon.svg",
    );
  });

  it("falls back to the brand favicon for third-party servers", () => {
    render(<McpIcon resourceUrl="https://mcp.stripe.com/" alt="Stripe" />);
    expect(screen.getByAltText("Stripe").getAttribute("src")).toContain(
      "stripe.com",
    );
  });
});

describe("brandDomain", () => {
  it("collapses subdomains to the registrable domain", () => {
    expect(brandDomain("mcp.stripe.com")).toBe("stripe.com");
    expect(brandDomain("notfair.co")).toBe("notfair.co");
  });
});
