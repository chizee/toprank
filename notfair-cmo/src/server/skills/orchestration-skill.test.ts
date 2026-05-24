import { describe, expect, it } from "vitest";

import {
  getOrchestrationSkill,
  ORCHESTRATION_SKILL,
} from "./orchestration-skill";

describe("ORCHESTRATION_SKILL", () => {
  it("getOrchestrationSkill() returns the exported constant verbatim (pure)", () => {
    expect(getOrchestrationSkill()).toBe(ORCHESTRATION_SKILL);
  });

  it("calling getOrchestrationSkill() multiple times returns the same string (cacheable / pure)", () => {
    expect(getOrchestrationSkill()).toBe(getOrchestrationSkill());
  });

  it("teaches the MCP tool surface (writing tools)", () => {
    const s = getOrchestrationSkill();
    for (const tool of [
      "create_task",
      "submit_task_status",
      "request_approval",
      "add_task_comment",
      "ask_user_question",
      "update_task",
      "cancel_task",
    ]) {
      expect(s).toContain(tool);
    }
  });

  it("teaches the read / context-reanchor tools", () => {
    const s = getOrchestrationSkill();
    for (const tool of [
      "get_task",
      "list_my_tasks",
      "list_tasks",
      "get_project",
      "list_task_comments",
      "get_approval",
      "list_my_approvals",
      "list_pending_approvals",
      "list_approvals_for_task",
    ]) {
      expect(s).toContain(tool);
    }
  });

  it("teaches the enum-discovery tools so agents don't guess", () => {
    const s = getOrchestrationSkill();
    expect(s).toContain("list_task_statuses");
    expect(s).toContain("list_approval_action_types");
    expect(s).toContain("list_project_agents");
  });

  it("forbids pseudo-XML pseudo-blocks (the rule that fixed the closed/done drift bug)", () => {
    const s = getOrchestrationSkill();
    expect(s).toMatch(/NEVER through pseudo-XML/);
    expect(s).toContain("`<create_task>`");
    expect(s).toContain("`<task_status>`");
  });

  it("documents the cannot-close-with-pending-approval invariant", () => {
    const s = getOrchestrationSkill();
    expect(s).toMatch(/can NOT close a task.*pending approval/i);
  });

  it("teaches cron CLI shape including --name '<project> / <agent> / <cron>'", () => {
    const s = getOrchestrationSkill();
    expect(s).toContain("openclaw cron add");
    expect(s).toContain("--no-deliver");
    expect(s).toContain("--json");
    expect(s).toContain(`"<project-slug> / <agent-slug> / <cron-name>"`);
  });

  it("documents <propose_cron> as the ONE pseudo-XML block still parsed (UI-only)", () => {
    const s = getOrchestrationSkill();
    expect(s).toContain("<propose_cron>");
    expect(s).toMatch(/ONLY pseudo-XML block/);
  });

  it("includes a 'Your role:' section selector so role-specific content sits ABOVE", () => {
    // The skill should sound like a how-to manual, NOT contain role
    // declarations like "You are the CMO" / "You are a worker" — those
    // live in CMO_ROLE / SPECIALIST_ROLE, not here.
    const s = getOrchestrationSkill();
    expect(s).not.toMatch(/^You are the CMO/m);
    expect(s).not.toMatch(/^You are a specialist worker/m);
  });
});
