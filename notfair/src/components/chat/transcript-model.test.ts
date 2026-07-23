import { describe, expect, it } from "vitest";

import type { TranscriptEvent } from "@/server/sessions/transcript-tail";
import {
  collapseEvents,
  nextToolGroupKey,
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
const lifecycle = (
  id: string,
  phase: string,
  ok?: boolean,
): TranscriptEvent => ({
  kind: "lifecycle",
  id,
  ts: t,
  phase,
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
    expect(group.key).toBe("tg:t1");
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

  it("keeps groups unique when a harness reuses tool ids across turns", () => {
    const items = collapseEvents([
      call("c1", "item_1"),
      text("a1", "first turn"),
      call("c2", "item_1"),
      text("a2", "second turn"),
    ]);
    const groups = items.filter((item) => item.kind === "tool_group");

    expect(groups.map((group) => group.key)).toEqual([
      "tg:item_1",
      "tg:item_1:1",
    ]);
    expect(nextToolGroupKey(items, "item_1")).toBe("tg:item_1:2");
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

  it("closes an unmatched tool call when the turn reaches a terminal boundary", () => {
    const items = collapseEvents([
      call("c1", "t1"),
      text("a1", "finished"),
      lifecycle("done-1", "done"),
    ]);
    const group = items[0] as Extract<
      ReturnType<typeof collapseEvents>[number],
      { kind: "tool_group" }
    >;
    expect(group.tools[0]).toMatchObject({ toolCallId: "t1", done: true });
  });

  it("marks an unmatched tool failed when the terminal boundary is an error", () => {
    const items = collapseEvents([
      call("c1", "t1"),
      text("err-1", "⚠ harness crashed"),
      lifecycle("done-1", "done", false),
    ]);
    const group = items[0] as Extract<
      ReturnType<typeof collapseEvents>[number],
      { kind: "tool_group" }
    >;
    expect(group.tools[0]).toMatchObject({
      toolCallId: "t1",
      done: true,
      ok: false,
    });
  });

  it("closes abandoned tools before a later turn reuses their id", () => {
    const items = collapseEvents([
      call("c1", "item_1"),
      user("u2", "try again"),
      lifecycle("start-2", "start"),
      call("c2", "item_1"),
    ]);
    const groups = items.filter((item) => item.kind === "tool_group");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.tools[0]).toMatchObject({
      toolCallId: "item_1",
      done: true,
      ok: false,
    });
    expect(groups[1]!.tools[0]).toMatchObject({
      toolCallId: "item_1",
      done: false,
    });
  });

  it("closes an unmatched tool when a fresh lifecycle starts without a user row", () => {
    const items = collapseEvents([
      call("c1", "item_1"),
      lifecycle("start-2", "start"),
      call("c2", "item_1"),
    ]);
    const group = items[0] as Extract<
      ReturnType<typeof collapseEvents>[number],
      { kind: "tool_group" }
    >;
    expect(group.tools).toHaveLength(2);
    expect(group.tools[0]).toMatchObject({
      toolCallId: "item_1",
      done: true,
      ok: false,
    });
    expect(group.tools[1]).toMatchObject({
      toolCallId: "item_1",
      done: false,
    });
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

  it("speaks MCP actions in natural language", () => {
    expect(
      humanizeTool("notfair_growth__notfair_googleads__listAdAccounts", null)
        .verb,
    ).toBe("Listed ad accounts");
    expect(humanizeTool("posthog.exec", "SELECT count() FROM events")).toEqual({
      verb: "Ran a query",
      target: "SELECT count() FROM events",
    });
    expect(humanizeTool("mcp__X__updateCampaignBudget", null).verb).toBe(
      "Updated campaign budget",
    );
    expect(humanizeTool("mcp__X__frobnicateWidget", null).verb).toBe(
      "Called frobnicate widget",
    );
    // PostHog's exec is a query engine — label-less legacy rows still
    // deserve the honest specific verb.
    expect(humanizeTool("notfair_growth__posthog.exec", null).verb).toBe(
      "Ran a query",
    );
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
