import { describe, expect, it } from "vitest";

import type { TranscriptEvent } from "@/server/sessions/transcript-tail";
import {
  collapseEvents,
  eventSignature,
  upsertToolEntry,
} from "./transcript-model";
import { humanizeTool, matchMcpServerKey } from "./tool-intent";

const t = 1_800_000_000_000;
const user = (id: string, body: string): TranscriptEvent => ({
  kind: "user_message",
  id,
  ts: t,
  body,
});
const text = (id: string, body: string): TranscriptEvent => ({
  kind: "assistant_text",
  id,
  ts: t,
  body,
});
const call = (id: string, tcid: string, name = "shell"): TranscriptEvent => ({
  kind: "tool_call",
  id,
  ts: t,
  tool_call_id: tcid,
  name,
  label: null,
});
const result = (id: string, tcid: string, ok = true): TranscriptEvent => ({
  kind: "tool_result",
  id,
  ts: t,
  tool_call_id: tcid,
  name: "shell",
  summary: null,
  ok,
});

describe("collapseEvents", () => {
  it("pairs calls with results and groups contiguous tools", () => {
    const items = collapseEvents([
      user("u1", "hi"),
      call("c1", "t1"),
      result("r1", "t1"),
      call("c2", "t2"),
      text("a1", "done"),
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "user_message",
      "tool_group",
      "assistant_text",
    ]);
    const group = items[1] as Extract<
      ReturnType<typeof collapseEvents>[number],
      { kind: "tool_group" }
    >;
    expect(group.tools).toHaveLength(2);
    expect(group.tools[0]).toMatchObject({ toolCallId: "t1", done: true });
    expect(group.tools[1]).toMatchObject({ toolCallId: "t2", done: false });
  });

  it("splits tool groups across intervening messages", () => {
    const items = collapseEvents([
      call("c1", "t1"),
      text("a1", "narration"),
      call("c2", "t2"),
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "tool_group",
      "assistant_text",
      "tool_group",
    ]);
  });

  it("keeps an orphan tool_result as its own done entry", () => {
    const items = collapseEvents([result("r9", "t9", false)]);
    expect(items).toHaveLength(1);
    const group = items[0] as Extract<
      ReturnType<typeof collapseEvents>[number],
      { kind: "tool_group" }
    >;
    expect(group.tools[0]).toMatchObject({ toolCallId: "t9", done: true, ok: false });
  });
});

describe("eventSignature", () => {
  it("keys messages by trimmed body and tools by call id", () => {
    expect(eventSignature(text("a", " same "))).toBe(eventSignature(text("b", "same")));
    expect(eventSignature(call("x", "t1"))).toBe("tool_call|t1");
  });
});

describe("upsertToolEntry", () => {
  it("inserts then completes an entry across phases", () => {
    let entries = upsertToolEntry([], {
      phase: "start",
      tool_call_id: "t1",
      name: "shell",
      label: "ls",
    });
    expect(entries[0]).toMatchObject({ done: false, label: "ls" });
    entries = upsertToolEntry(entries, {
      phase: "result",
      tool_call_id: "t1",
      name: "shell",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ done: true, label: "ls" });
  });
});

describe("humanizeTool", () => {
  it("maps shell command lines to verb phrases", () => {
    expect(humanizeTool("shell", "/bin/zsh -lc 'git status --short'")).toEqual({
      verb: "Ran git status",
    });
    expect(humanizeTool("shell", `rg -n "needle" src`).verb).toBe(
      "Searched files",
    );
  });

  it("prettifies namespaced MCP tool names", () => {
    expect(
      humanizeTool("notfair_growth__notfair_googleads__listAdAccounts", null)
        .verb,
    ).toBe("Called list ad accounts");
  });
});

describe("matchMcpServerKey", () => {
  const catalog = [
    { key: "NotFair-GoogleAds", display_name: "Google Ads", resource_url: "https://notfair.co" },
  ];
  it("matches both harness namespace schemes", () => {
    expect(
      matchMcpServerKey("mcp__NotFair-GoogleAds__createCampaign", catalog)
        ?.display_name,
    ).toBe("Google Ads");
    expect(
      matchMcpServerKey("notfair_demo1__notfair_googleads__runScript", catalog)
        ?.display_name,
    ).toBe("Google Ads");
    expect(matchMcpServerKey("shell", catalog)).toBeNull();
  });
});
