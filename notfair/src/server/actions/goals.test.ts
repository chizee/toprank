import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveAchievedGoal: vi.fn(),
  continueAchievedGoal: vi.fn(),
  revalidatePath: vi.fn(),
  createGoal: vi.fn(),
  deleteGoalsForAgent: vi.fn(),
  endActionObservation: vi.fn(),
  getGoal: vi.fn(),
  getGoalAction: vi.fn(),
  getGoalForAgent: vi.fn(),
  renameGoal: vi.fn(),
  reviewGoalAction: vi.fn(),
  setGoalPinned: vi.fn(),
  setGoalStatus: vi.fn(),
  cascadeDeleteAgentArtifacts: vi.fn(),
  getProject: vi.fn(),
  provisionGoalAgent: vi.fn(),
  syncGoalIdentity: vi.fn(),
  agentExistsOnDisk: vi.fn(),
  listProjectAgents: vi.fn(),
  runGoalIntake: vi.fn(),
  runGoalTick: vi.fn(),
  listCheckRows: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db/goals", () => ({
  archiveAchievedGoal: mocks.archiveAchievedGoal,
  continueAchievedGoal: mocks.continueAchievedGoal,
  createGoal: mocks.createGoal,
  deleteGoalsForAgent: mocks.deleteGoalsForAgent,
  endActionObservation: mocks.endActionObservation,
  getGoal: mocks.getGoal,
  getGoalAction: mocks.getGoalAction,
  getGoalForAgent: mocks.getGoalForAgent,
  renameGoal: mocks.renameGoal,
  reviewGoalAction: mocks.reviewGoalAction,
  setGoalPinned: mocks.setGoalPinned,
  setGoalStatus: mocks.setGoalStatus,
  USER_ACTION_PREFIX: "[USER ACTION] ",
}));
vi.mock("@/server/agents/cascade-delete", () => ({
  cascadeDeleteAgentArtifacts: mocks.cascadeDeleteAgentArtifacts,
}));
vi.mock("@/server/db/projects", () => ({ getProject: mocks.getProject }));
vi.mock("@/server/goals/provision", () => ({
  goalAgentIdFor: (slug: string, n: number) => `${slug}--goal-${n}`,
  goalAgentUrlSlug: (n: number) => `goal-${n}`,
  provisionGoalAgent: mocks.provisionGoalAgent,
  syncGoalIdentity: mocks.syncGoalIdentity,
}));
vi.mock("@/server/agent-meta", () => ({
  agentExistsOnDisk: mocks.agentExistsOnDisk,
  listProjectAgents: mocks.listProjectAgents,
}));
vi.mock("@/server/goals/intake", () => ({ runGoalIntake: mocks.runGoalIntake }));
vi.mock("@/server/goals/tick", () => ({ runGoalTick: mocks.runGoalTick }));
vi.mock("@/server/goals/checks", () => ({ listCheckRows: mocks.listCheckRows }));

import {
  archiveCompletedGoalAction,
  continueCompletedGoalAction,
  createGoalAgentAction,
  deleteGoalAction,
  getAgentGoalAction,
  killGoalAction,
  loadMoreGoalChecksAction,
  markUserActionHandledAction,
  pauseGoalAction,
  releaseLockAction,
  renameGoalAction,
  resumeGoalAction,
  runTickNowAction,
  setGoalPinnedAction,
} from "./goals";

const goal = {
  id: "goal-db-1",
  project_slug: "acme",
  agent_id: "acme--goal-3",
  status: "active",
  statement: "Grow",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockReturnValue({ slug: "acme" });
  mocks.listProjectAgents.mockResolvedValue([]);
  mocks.agentExistsOnDisk.mockResolvedValue(false);
  mocks.createGoal.mockReturnValue(goal);
  mocks.archiveAchievedGoal.mockReturnValue({ ...goal, status: "achieved" });
  mocks.continueAchievedGoal.mockReturnValue(goal);
  mocks.provisionGoalAgent.mockResolvedValue(undefined);
  mocks.syncGoalIdentity.mockResolvedValue(undefined);
  mocks.runGoalIntake.mockResolvedValue(undefined);
  mocks.runGoalTick.mockResolvedValue(undefined);
  mocks.getGoal.mockReturnValue(goal);
  mocks.setGoalStatus.mockReturnValue(goal);
  mocks.renameGoal.mockReturnValue(goal);
});

describe("createGoalAgentAction", () => {
  it("validates the project and non-empty statement", async () => {
    mocks.getProject.mockReturnValue(null);
    await expect(createGoalAgentAction({ project_slug: "x", statement: "hi" })).resolves.toEqual({
      ok: false,
      error: "Project not found.",
    });
    mocks.getProject.mockReturnValue({ slug: "acme" });
    await expect(createGoalAgentAction({ project_slug: "acme", statement: "  " })).resolves.toEqual({
      ok: false,
      error: "Say what you want to achieve.",
    });
  });

  it("allocates after the largest sequential agent and skips orphaned dirs", async () => {
    mocks.listProjectAgents.mockResolvedValue([
      { slug: "goal-2" },
      { slug: "goal-7" },
      { slug: "named-agent" },
    ]);
    mocks.agentExistsOnDisk
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const result = await createGoalAgentAction({
      project_slug: "acme",
      statement: "  Grow now  ",
      focus: "SEO",
    });
    expect(mocks.createGoal).toHaveBeenCalledWith({
      project_slug: "acme",
      agent_id: "acme--goal-9",
      statement: "Grow now",
    });
    expect(mocks.provisionGoalAgent).toHaveBeenCalledWith({ goal, urlSlug: "goal-9" });
    expect(mocks.runGoalIntake).toHaveBeenCalledWith(goal, { focus: "SEO" });
    expect(result).toEqual({ ok: true, goal_id: goal.id, agent_slug: "goal-9" });
  });

  it.each([new Error("duplicate"), "string failure"])("surfaces create failure %#", async (failure) => {
    mocks.createGoal.mockImplementation(() => { throw failure; });
    await expect(createGoalAgentAction({ project_slug: "acme", statement: "Grow" })).resolves.toEqual({
      ok: false,
      error: failure instanceof Error ? failure.message : failure,
    });
  });

  it.each([new Error("disk full"), "bad provision"])("kills a stranded goal on provision failure %#", async (failure) => {
    mocks.provisionGoalAgent.mockRejectedValue(failure);
    const result = await createGoalAgentAction({ project_slug: "acme", statement: "Grow" });
    expect(mocks.setGoalStatus).toHaveBeenCalledWith(goal.id, "killed", "provisioning failed");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(failure instanceof Error ? failure.message : failure),
    });
  });
});

describe("goal lifecycle actions", () => {
  it("pauses, kills, renames, and pins existing goals", async () => {
    await expect(pauseGoalAction(goal.id)).resolves.toEqual({ ok: true });
    await expect(killGoalAction(goal.id, "  done  ")).resolves.toEqual({ ok: true });
    expect(mocks.setGoalStatus).toHaveBeenCalledWith(goal.id, "killed", "done");
    await expect(killGoalAction(goal.id, " ")).resolves.toEqual({ ok: true });
    expect(mocks.setGoalStatus).toHaveBeenLastCalledWith(goal.id, "killed", "closed by user");
    await expect(renameGoalAction(goal.id, "  Better label ")).resolves.toEqual({ ok: true });
    expect(mocks.renameGoal).toHaveBeenCalledWith(goal.id, "Better label");
    await expect(setGoalPinnedAction(goal.id, true)).resolves.toEqual({ ok: true });
    expect(mocks.setGoalPinned).toHaveBeenCalledWith(goal.id, true);
  });

  it("returns not-found and validation errors", async () => {
    mocks.setGoalStatus.mockReturnValue(null);
    await expect(pauseGoalAction("missing")).resolves.toMatchObject({ ok: false });
    await expect(killGoalAction("missing")).resolves.toMatchObject({ ok: false });
    await expect(renameGoalAction(goal.id, " ")).resolves.toMatchObject({ ok: false });
    mocks.renameGoal.mockReturnValue(null);
    await expect(renameGoalAction("missing", "Name")).resolves.toMatchObject({ ok: false });
    mocks.getGoal.mockReturnValue(null);
    await expect(setGoalPinnedAction("missing", true)).resolves.toMatchObject({ ok: false });
  });

  it("resumes only paused goals", async () => {
    mocks.getGoal.mockReturnValue(null);
    await expect(resumeGoalAction("missing")).resolves.toMatchObject({ ok: false });
    mocks.getGoal.mockReturnValue({ ...goal, status: "active" });
    await expect(resumeGoalAction(goal.id)).resolves.toEqual({
      ok: false,
      error: "Goal is active, not paused.",
    });
    mocks.getGoal.mockReturnValue({ ...goal, status: "paused" });
    await expect(resumeGoalAction(goal.id)).resolves.toEqual({ ok: true });
    expect(mocks.setGoalStatus).toHaveBeenCalledWith(goal.id, "active", "resumed by user");
  });

  it("archives an achievement without deleting it", async () => {
    await expect(archiveCompletedGoalAction(goal.id)).resolves.toEqual({ ok: true });
    expect(mocks.archiveAchievedGoal).toHaveBeenCalledWith(goal.id);
    expect(mocks.deleteGoalsForAgent).not.toHaveBeenCalled();

    mocks.archiveAchievedGoal.mockReturnValue(null);
    await expect(archiveCompletedGoalAction(goal.id)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("continues an achievement with a new milestone and immediate check", async () => {
    const continued = { ...goal, target_value: 150 };
    mocks.continueAchievedGoal.mockReturnValue(continued);
    await expect(
      continueCompletedGoalAction(goal.id, {
        target_value: 150,
        deadline: "2030-12-31",
        label: "Qualified visits → 150",
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.continueAchievedGoal).toHaveBeenCalledWith(goal.id, {
      target_value: 150,
      deadline: "2030-12-31",
      short_label: "Qualified visits → 150",
    });
    expect(mocks.syncGoalIdentity).toHaveBeenCalledWith(continued);
    expect(mocks.runGoalTick).toHaveBeenCalledWith(continued, "manual");
  });
});

describe("deletion, locks, and escalations", () => {
  it("deletes agent artifacts before database rows", async () => {
    mocks.cascadeDeleteAgentArtifacts.mockResolvedValue(undefined);
    await expect(deleteGoalAction(goal.id)).resolves.toEqual({ ok: true });
    expect(mocks.cascadeDeleteAgentArtifacts).toHaveBeenCalledWith("acme", "acme--goal-3");
    expect(mocks.deleteGoalsForAgent).toHaveBeenCalledWith("acme--goal-3");
    expect(mocks.cascadeDeleteAgentArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteGoalsForAgent.mock.invocationCallOrder[0]!,
    );
    mocks.getGoal.mockReturnValue(null);
    await expect(deleteGoalAction("missing")).resolves.toMatchObject({ ok: false });
  });

  it("releases existing observation locks", async () => {
    mocks.endActionObservation.mockReturnValue(false);
    await expect(releaseLockAction("x")).resolves.toMatchObject({ ok: false });
    mocks.endActionObservation.mockReturnValue({ id: "x" });
    await expect(releaseLockAction("x")).resolves.toEqual({ ok: true });
  });

  it("only marks open prefixed decision actions handled", async () => {
    for (const action of [
      null,
      { kind: "mutation", description: "[USER ACTION] fix" },
      { kind: "decision", description: "ordinary" },
    ]) {
      mocks.getGoalAction.mockReturnValue(action);
      await expect(markUserActionHandledAction("a")).resolves.toMatchObject({ ok: false });
    }
    mocks.getGoalAction.mockReturnValue({ kind: "decision", description: "[USER ACTION] fix billing" });
    mocks.reviewGoalAction.mockReturnValue(null);
    await expect(markUserActionHandledAction("a")).resolves.toEqual({ ok: false, error: "Already closed." });
    mocks.reviewGoalAction.mockReturnValue({ id: "a" });
    await expect(markUserActionHandledAction("a")).resolves.toEqual({ ok: true });
  });
});

describe("ticks and read helpers", () => {
  it("runs manual ticks only for active goals", async () => {
    mocks.getGoal.mockReturnValue(null);
    await expect(runTickNowAction("missing")).resolves.toMatchObject({ ok: false });
    mocks.getGoal.mockReturnValue({ ...goal, status: "paused" });
    await expect(runTickNowAction(goal.id)).resolves.toEqual({
      ok: false,
      error: "Goal is paused — only active goals tick.",
    });
    mocks.getGoal.mockReturnValue(goal);
    await expect(runTickNowAction(goal.id)).resolves.toEqual({ ok: true });
    expect(mocks.runGoalTick).toHaveBeenCalledWith(goal, "manual");
  });

  it("returns the agent goal and paginated check rows", async () => {
    mocks.getGoalForAgent.mockReturnValue(goal);
    await expect(getAgentGoalAction(goal.agent_id)).resolves.toBe(goal);
    mocks.listCheckRows.mockReturnValue({ rows: [{ tick_number: 4 }], hasMore: true });
    await expect(loadMoreGoalChecksAction(goal.id, 5, "action")).resolves.toEqual({
      rows: [{ tick_number: 4 }],
      hasMore: true,
    });
    expect(mocks.listCheckRows).toHaveBeenCalledWith(goal.id, { beforeTick: 5, filter: "action" });
    mocks.getGoal.mockReturnValue(null);
    await expect(loadMoreGoalChecksAction("missing")).resolves.toEqual({ rows: [], hasMore: false });
  });
});
