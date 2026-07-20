import { describe, expect, it } from "vitest";

import { makeCodexStreamState, parseCodexLine } from "./parse";

const line = (obj: unknown) => JSON.stringify(obj);

describe("parseCodexLine — MCP tool labels", () => {
  it("carries the query argument of an mcp_tool_call into the label", () => {
    const events = parseCodexLine(
      line({
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          id: "item_1",
          server: "notfair_growth__posthog",
          tool: "exec",
          arguments: {
            query: "SELECT count() FROM events\nWHERE timestamp >= now()",
          },
        },
      }),
      makeCodexStreamState(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool",
      phase: "start",
      name: "notfair_growth__posthog.exec",
      // First line only, so the collapsed row stays one line.
      label: "SELECT count() FROM events",
    });
  });

  it("falls back to a compact key=value digest when no string field matches", () => {
    const events = parseCodexLine(
      line({
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          id: "item_2",
          server: "s",
          tool: "updateCampaignBudget",
          arguments: { campaign_id: 12345, amount_micros: 5_000_000, validate: true },
        },
      }),
      makeCodexStreamState(),
    );
    expect(events[0]).toMatchObject({
      label: "campaign_id=12345  amount_micros=5000000  validate=true",
    });
  });

  it("leaves the label undefined when there are no arguments", () => {
    const events = parseCodexLine(
      line({
        type: "item.started",
        item: { type: "mcp_tool_call", id: "item_3", server: "s", tool: "t" },
      }),
      makeCodexStreamState(),
    );
    expect(events[0]).toMatchObject({ kind: "tool" });
    expect((events[0] as { label?: string }).label).toBeUndefined();
  });
});
