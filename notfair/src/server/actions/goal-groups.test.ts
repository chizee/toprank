import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  get: vi.fn(),
  rename: vi.fn(),
  save: vi.fn(),
  setMembership: vi.fn(),
  getGoal: vi.fn(),
  getProject: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db/goal-groups", () => ({
  createGoalGroup: mocks.create,
  deleteGoalGroup: mocks.remove,
  getGoalGroup: mocks.get,
  renameGoalGroup: mocks.rename,
  saveGoalGroup: mocks.save,
  setGoalGroupMembership: mocks.setMembership,
}));
vi.mock("@/server/db/goals", () => ({ getGoal: mocks.getGoal }));
vi.mock("@/server/db/projects", () => ({ getProject: mocks.getProject }));

import {
  createGoalGroupAction,
  deleteGoalGroupAction,
  moveGoalToGroupAction,
  renameGoalGroupAction,
  saveGoalGroupAction,
} from "./goal-groups";

const group = { id: "group-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockReturnValue({ slug: "acme" });
  mocks.get.mockReturnValue(group);
  mocks.getGoal.mockReturnValue({ id: "goal-1" });
  mocks.create.mockReturnValue(group);
  mocks.save.mockReturnValue(group);
  mocks.rename.mockReturnValue(group);
  mocks.remove.mockReturnValue(true);
});

it("creates a trimmed group with default goal ids", async () => {
  await expect(createGoalGroupAction({ project_slug: "acme", name: "  Growth ", description: " focus " })).resolves.toEqual({
    ok: true,
    group_id: "group-1",
  });
  expect(mocks.create).toHaveBeenCalledWith({
    project_slug: "acme",
    name: "Growth",
    description: "focus",
    goal_ids: [],
  });
});

it("validates project, name, and description lengths", async () => {
  mocks.getProject.mockReturnValue(null);
  await expect(createGoalGroupAction({ project_slug: "x", name: "a" })).resolves.toMatchObject({ ok: false });
  mocks.getProject.mockReturnValue({});
  await expect(createGoalGroupAction({ project_slug: "x", name: " " })).resolves.toMatchObject({ error: expect.stringContaining("empty") });
  await expect(createGoalGroupAction({ project_slug: "x", name: "a".repeat(81) })).resolves.toMatchObject({ error: expect.stringContaining("80") });
  await expect(createGoalGroupAction({ project_slug: "x", name: "a", description: "d".repeat(241) })).resolves.toMatchObject({ error: expect.stringContaining("240") });
});

it.each([
  [new Error("UNIQUE constraint failed: groups.name"), "already exists"],
  [new Error("database down"), "database down"],
  ["plain failure", "plain failure"],
])("maps create errors %#", async (failure, message) => {
  mocks.create.mockImplementation(() => { throw failure; });
  await expect(createGoalGroupAction({ project_slug: "acme", name: "Growth" })).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining(message),
  });
});

it("saves, renames, moves, and deletes groups", async () => {
  await expect(saveGoalGroupAction({ group_id: "group-1", name: " New ", goal_ids: ["g1"] })).resolves.toMatchObject({ ok: true });
  expect(mocks.save).toHaveBeenCalledWith({ id: "group-1", name: "New", description: "", goal_ids: ["g1"] });
  await expect(renameGoalGroupAction("group-1", " Renamed ")).resolves.toMatchObject({ ok: true });
  await expect(moveGoalToGroupAction("goal-1", "group-1")).resolves.toEqual({ ok: true, group_id: "group-1" });
  await expect(moveGoalToGroupAction("goal-1", null)).resolves.toEqual({ ok: true, group_id: undefined });
  await expect(deleteGoalGroupAction("group-1")).resolves.toEqual({ ok: true });
  expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
});

it("returns missing-row outcomes from mutations", async () => {
  mocks.get.mockReturnValue(null);
  await expect(saveGoalGroupAction({ group_id: "x", name: "A", goal_ids: [] })).resolves.toMatchObject({ ok: false });
  mocks.get.mockReturnValue(group);
  mocks.save.mockReturnValue(null);
  await expect(saveGoalGroupAction({ group_id: "x", name: "A", goal_ids: [] })).resolves.toMatchObject({ ok: false });
  mocks.rename.mockReturnValue(null);
  await expect(renameGoalGroupAction("x", "A")).resolves.toMatchObject({ ok: false });
  mocks.getGoal.mockReturnValue(null);
  await expect(moveGoalToGroupAction("x", null)).resolves.toMatchObject({ ok: false });
  mocks.remove.mockReturnValue(false);
  await expect(deleteGoalGroupAction("x")).resolves.toMatchObject({ ok: false });
});

it("maps save, rename, and membership exceptions", async () => {
  mocks.save.mockImplementation(() => { throw new Error("save failed"); });
  await expect(saveGoalGroupAction({ group_id: "x", name: "A", goal_ids: [] })).resolves.toMatchObject({ error: "save failed" });
  mocks.rename.mockImplementation(() => { throw "rename failed"; });
  await expect(renameGoalGroupAction("x", "A")).resolves.toMatchObject({ error: "rename failed" });
  mocks.setMembership.mockImplementation(() => { throw new Error("move failed"); });
  await expect(moveGoalToGroupAction("goal-1", "x")).resolves.toMatchObject({ error: "move failed" });
});
