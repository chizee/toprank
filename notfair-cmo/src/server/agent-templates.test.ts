import { describe, expect, it } from "vitest";

import {
  TEMPLATES,
  templateForKey,
  templateForUrlSlug,
  agentUrlSlug,
  DEFAULT_ONBOARDING_TEMPLATE_KEYS,
  SPECIALIST_TEMPLATE_BY_MCP_KEY,
} from "./agent-templates";

describe("AgentTemplate catalog", () => {
  it("ships exactly five templates: cmo + 3 recommended specialists + seo", () => {
    const keys = TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual(["cmo", "google_ads", "gsc", "meta_ads", "seo"]);
  });

  it("only CMO is included in the default onboarding bundle", () => {
    expect(DEFAULT_ONBOARDING_TEMPLATE_KEYS).toEqual(["cmo"]);
    expect(TEMPLATES.filter((t) => t.default_onboarding).map((t) => t.key)).toEqual(
      ["cmo"],
    );
  });

  it("the three specialists declare their required MCP catalog key", () => {
    expect(templateForKey("google_ads")?.requires_mcp_key).toBe(
      "notfair-googleads",
    );
    expect(templateForKey("meta_ads")?.requires_mcp_key).toBe(
      "notfair-metaads",
    );
    expect(templateForKey("gsc")?.requires_mcp_key).toBe(
      "notfair-googlesearchconsole",
    );
  });

  it("CMO has no requires_mcp_key — it never blocks", () => {
    expect(templateForKey("cmo")?.requires_mcp_key).toBeUndefined();
  });

  it("SPECIALIST_TEMPLATE_BY_MCP_KEY inverts requires_mcp_key for connect-time provisioning", () => {
    expect(SPECIALIST_TEMPLATE_BY_MCP_KEY["notfair-googleads"]).toBe(
      "google_ads",
    );
    expect(SPECIALIST_TEMPLATE_BY_MCP_KEY["notfair-metaads"]).toBe("meta_ads");
    expect(SPECIALIST_TEMPLATE_BY_MCP_KEY["notfair-googlesearchconsole"]).toBe(
      "gsc",
    );
    expect(SPECIALIST_TEMPLATE_BY_MCP_KEY["stripe"]).toBeUndefined();
  });

  it("templateForUrlSlug resolves the hyphenated URL form (gsc has no underscore so it round-trips trivially)", () => {
    expect(templateForUrlSlug("google-ads")?.key).toBe("google_ads");
    expect(templateForUrlSlug("meta-ads")?.key).toBe("meta_ads");
    expect(templateForUrlSlug("gsc")?.key).toBe("gsc");
  });

  it("agentUrlSlug produces stable slugs for the new templates", () => {
    expect(agentUrlSlug("meta_ads", "Mia")).toBe("meta-ads-mia");
    expect(agentUrlSlug("gsc", "Sasha")).toBe("gsc-sasha");
  });
});
