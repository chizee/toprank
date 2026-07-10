import { describe, expect, it } from "vitest";

import type { Task } from "@/types";

import {
  buildTaskKickoffMessage,
  formatPlatformFacts,
  type ProjectPlatformFacts,
} from "./task-kickoff";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-123",
    display_id: "demo-1",
    project_slug: "demo",
    agent_id: "demo-google-ads",
    title: "Install conversion tracking",
    brief: "Add the Google Ads conversion tag to /thanks.",
    success_criteria: "Tag fires on /thanks and a test conv lands in Google Ads.",
    deadline_iso: null,
    status: "working",
    result_json: null,
    error_message: null,
    thread_id: "thread-1",
    assigner_agent_id: "demo-cmo",
    blocked_by_task_id: null,
    created_at: "2026-05-19T00:00:00Z",
    updated_at: "2026-05-19T00:00:00Z",
    ...overrides,
  };
}

describe("buildTaskKickoffMessage", () => {
  it("opens with the (task assignment) header so the agent recognizes the system-injected turn", () => {
    const msg = buildTaskKickoffMessage(makeTask());
    expect(msg.startsWith("(task assignment)")).toBe(true);
  });

  it("includes the canonical task fields in a stable order", () => {
    const msg = buildTaskKickoffMessage(makeTask());
    // Each piece appears, and the brief comes before success criteria.
    expect(msg).toContain("task_id:      task-123");
    expect(msg).toContain("project_slug: demo");
    expect(msg).toContain("agent_id:     demo-google-ads");
    expect(msg).toContain("Title:        Install conversion tracking");
    expect(msg).toContain("Brief:");
    expect(msg).toContain("Add the Google Ads conversion tag to /thanks.");
    expect(msg).toContain("Success criteria:");
    expect(msg).toContain(
      "Tag fires on /thanks and a test conv lands in Google Ads.",
    );
    expect(msg.indexOf("Brief:")).toBeLessThan(msg.indexOf("Success criteria:"));
  });

  it("falls back to '(untitled)' when title is null", () => {
    const msg = buildTaskKickoffMessage(makeTask({ title: null }));
    expect(msg).toContain("Title:        (untitled)");
  });

  it("omits the Success criteria section entirely when success_criteria is null", () => {
    const msg = buildTaskKickoffMessage(
      makeTask({ success_criteria: null }),
    );
    expect(msg).not.toContain("Success criteria:");
    // Still has the trailing instructions block.
    expect(msg).toContain("Acknowledge this task");
  });

  it("tells the agent to actually use its tools, not just describe, and to close out when done", () => {
    const msg = buildTaskKickoffMessage(makeTask());
    expect(msg).toContain("Use your domain tools");
    expect(msg).toContain("don't just describe what you'd do");
    expect(msg).toMatch(/close the task out/i);
  });

  it("does NOT re-teach the MCP tool surface — that's the system prompt's job", () => {
    const msg = buildTaskKickoffMessage(makeTask());
    // Schema-shaped lines like `status: "done"` belong in the system prompt;
    // every brief shouldn't duplicate them. Same for the pseudo-XML rule.
    expect(msg).not.toMatch(/status:\s*"done"/);
    expect(msg).not.toMatch(/do NOT emit/i);
    expect(msg).not.toContain("not parsed");
  });

  it("returns a multi-line string (joined with \\n, not \\r\\n)", () => {
    const msg = buildTaskKickoffMessage(makeTask());
    expect(msg).not.toContain("\r");
    expect(msg.split("\n").length).toBeGreaterThan(6);
  });

  it("preserves multi-line brief content verbatim", () => {
    const brief = "Step 1: import GA4.\nStep 2: map conv to lead.\nStep 3: verify.";
    const msg = buildTaskKickoffMessage(makeTask({ brief }));
    expect(msg).toContain(brief);
  });
});

describe("platform facts block", () => {
  const facts: ProjectPlatformFacts = {
    website_url: "https://example.com",
    codebase_path: null,
    connected: [
      { label: "Google Ads", detail: "account 7384288909" },
      { label: "X Ads", detail: null },
    ],
    notConnected: ["Meta Ads", "Google Search Console", "Google Analytics"],
  };

  it("renders connected platforms with details and NOT-connected ones explicitly", () => {
    const lines = formatPlatformFacts(facts).join("\n");
    expect(lines).toContain("ground truth from the platform database");
    expect(lines).toContain("- Google Ads: connected — account 7384288909");
    expect(lines).toContain("- X Ads: connected");
    expect(lines).toContain("- Meta Ads: NOT connected");
    expect(lines).toContain("- Website: https://example.com");
    expect(lines).not.toContain("Local codebase");
  });

  it("kickoff message embeds the facts block between brief and success criteria", () => {
    const msg = buildTaskKickoffMessage(makeTask(), facts);
    expect(msg).toContain("- Google Ads: connected — account 7384288909");
    expect(msg.indexOf("Brief:")).toBeLessThan(msg.indexOf("Google Ads: connected"));
    expect(msg.indexOf("Google Ads: connected")).toBeLessThan(
      msg.indexOf("Success criteria:"),
    );
  });

  it("kickoff message omits the block when facts are null/undefined", () => {
    expect(buildTaskKickoffMessage(makeTask(), null)).not.toContain(
      "Platform connections",
    );
    expect(buildTaskKickoffMessage(makeTask())).not.toContain(
      "Platform connections",
    );
  });
});
