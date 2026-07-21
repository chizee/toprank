import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  getSuggestion: vi.fn(),
  markAccepted: vi.fn(),
  markDismissed: vi.fn(),
  analyzableSources: vi.fn(),
  generate: vi.fn(),
  createGoal: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db/suggestions", () => ({
  getSuggestion: mocks.getSuggestion,
  markSuggestionAccepted: mocks.markAccepted,
  markSuggestionDismissed: mocks.markDismissed,
}));
vi.mock("@/server/suggestions/engine", () => ({
  analyzableSources: mocks.analyzableSources,
  generateSuggestionsForSource: mocks.generate,
}));
vi.mock("@/server/actions/goals", () => ({ createGoalAgentAction: mocks.createGoal }));

import { acceptSuggestionAction, dismissSuggestionAction, refreshSuggestionsAction } from "./suggestions";

const suggestion = { id: "s1", status: "open", project_slug: "acme", statement: "Grow" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSuggestion.mockReturnValue(suggestion);
  mocks.createGoal.mockResolvedValue({ ok: true, goal_id: "g1" });
  mocks.analyzableSources.mockReturnValue(["google", "meta"]);
});

it("accepts an open suggestion after creating its goal", async () => {
  await expect(acceptSuggestionAction("s1")).resolves.toEqual({ ok: true, goal_id: "g1" });
  expect(mocks.createGoal).toHaveBeenCalledWith({ project_slug: "acme", statement: "Grow" });
  expect(mocks.markAccepted).toHaveBeenCalledWith("s1", "g1");
});

it("rejects missing/handled suggestions and leaves failed goal creation open", async () => {
  mocks.getSuggestion.mockReturnValue(null);
  await expect(acceptSuggestionAction("x")).resolves.toMatchObject({ ok: false });
  mocks.getSuggestion.mockReturnValue({ ...suggestion, status: "dismissed" });
  await expect(acceptSuggestionAction("s1")).resolves.toMatchObject({ ok: false });
  mocks.getSuggestion.mockReturnValue(suggestion);
  mocks.createGoal.mockResolvedValue({ ok: false, error: "no" });
  await expect(acceptSuggestionAction("s1")).resolves.toMatchObject({ ok: false });
  expect(mocks.markAccepted).not.toHaveBeenCalled();
});

it("dismisses only open suggestions", async () => {
  await expect(dismissSuggestionAction("s1")).resolves.toEqual({ ok: true });
  expect(mocks.markDismissed).toHaveBeenCalledWith("s1");
  mocks.getSuggestion.mockReturnValue({ ...suggestion, status: "accepted" });
  await expect(dismissSuggestionAction("s1")).resolves.toEqual({ ok: false });
  mocks.getSuggestion.mockReturnValue(null);
  await expect(dismissSuggestionAction("x")).resolves.toEqual({ ok: false });
});

it("fires suggestion generation for each analyzable source", async () => {
  await expect(refreshSuggestionsAction("acme")).resolves.toEqual({ ok: true, sources: 2 });
  expect(mocks.generate).toHaveBeenCalledWith("acme", "google");
  expect(mocks.generate).toHaveBeenCalledWith("acme", "meta");
});
