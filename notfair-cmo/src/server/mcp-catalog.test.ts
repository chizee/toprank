import { describe, expect, it } from "vitest";

import { MCP_CATALOG, mcpSpecByKey, storedMcpKey } from "./mcp-catalog";

describe("MCP_CATALOG", () => {
  it("contains at least one spec", () => {
    expect(MCP_CATALOG.length).toBeGreaterThan(0);
  });

  it("includes the notfair-googleads spec with all required fields", () => {
    const ga = MCP_CATALOG.find((m) => m.key === "notfair-googleads");
    expect(ga).toBeDefined();
    expect(ga).toMatchObject({
      key: "notfair-googleads",
      display_name: expect.any(String),
      description: expect.any(String),
      resource_url: expect.stringMatching(/^https:\/\//),
      discovery_url: expect.stringMatching(/^https:\/\//),
    });
  });

  it("every spec has all required fields populated", () => {
    for (const spec of MCP_CATALOG) {
      expect(typeof spec.key).toBe("string");
      expect(spec.key.length).toBeGreaterThan(0);
      expect(typeof spec.display_name).toBe("string");
      expect(typeof spec.description).toBe("string");
      expect(typeof spec.resource_url).toBe("string");
      expect(typeof spec.discovery_url).toBe("string");
    }
  });

  it("every spec key is unique", () => {
    const keys = MCP_CATALOG.map((m) => m.key);
    const uniq = new Set(keys);
    expect(uniq.size).toBe(keys.length);
  });
});

describe("mcpSpecByKey", () => {
  it("returns the spec when key matches", () => {
    const spec = mcpSpecByKey("notfair-googleads");
    expect(spec).toBeDefined();
    expect(spec?.key).toBe("notfair-googleads");
  });

  it("returns undefined for an unknown key", () => {
    expect(mcpSpecByKey("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for an empty key", () => {
    expect(mcpSpecByKey("")).toBeUndefined();
  });

  it("is case-sensitive — uppercase variant does not match", () => {
    expect(mcpSpecByKey("NOTFAIR-GOOGLEADS")).toBeUndefined();
  });
});

describe("storedMcpKey", () => {
  it("concatenates project slug + catalog key with a hyphen", () => {
    expect(storedMcpKey("acme", "notfair-googleads")).toBe(
      "acme-notfair-googleads",
    );
  });

  it("preserves multi-segment project slugs", () => {
    expect(storedMcpKey("acme-q4", "notfair-googleads")).toBe(
      "acme-q4-notfair-googleads",
    );
  });

  it("works with arbitrary catalog keys (not just ones in the catalog)", () => {
    expect(storedMcpKey("proj", "arbitrary-thing")).toBe("proj-arbitrary-thing");
  });

  it("handles empty project slug (no validation here — that's the caller's job)", () => {
    expect(storedMcpKey("", "notfair-googleads")).toBe("-notfair-googleads");
  });

  it("handles empty catalog key", () => {
    expect(storedMcpKey("acme", "")).toBe("acme-");
  });
});
