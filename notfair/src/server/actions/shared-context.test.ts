import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  getProject: vi.fn(),
  writeBrief: vi.fn(),
  syncAgents: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db/projects", () => ({ getProject: mocks.getProject }));
vi.mock("@/server/onboarding/project-brief", () => ({
  writeProjectBrief: mocks.writeBrief,
  PROJECT_BRIEF_MAX_BYTES: 16,
}));
vi.mock("@/server/goals/provision", () => ({ syncProjectAgents: mocks.syncAgents }));

import { saveSharedContextAction } from "./shared-context";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockReturnValue({ slug: "acme" });
  mocks.writeBrief.mockResolvedValue(undefined);
  mocks.syncAgents.mockResolvedValue(3);
});

it("validates project, content, and UTF-8 byte length", async () => {
  mocks.getProject.mockReturnValue(null);
  await expect(saveSharedContextAction({ project_slug: "x", content: "brief" })).resolves.toMatchObject({ ok: false });
  mocks.getProject.mockReturnValue({});
  await expect(saveSharedContextAction({ project_slug: "x", content: "  " })).resolves.toMatchObject({ error: expect.stringContaining("empty") });
  await expect(saveSharedContextAction({ project_slug: "x", content: "🌍🌍🌍🌍🌍" })).resolves.toMatchObject({ error: expect.stringContaining("Too long") });
});

it("writes trimmed content, syncs agents, and revalidates", async () => {
  await expect(saveSharedContextAction({ project_slug: "acme", content: "  company brief  " })).resolves.toEqual({
    ok: true,
    synced_agents: 3,
  });
  expect(mocks.writeBrief).toHaveBeenCalledWith("acme", "company brief");
  expect(mocks.syncAgents).toHaveBeenCalledWith("acme");
  expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
});

it.each([new Error("disk full"), "sync failed"])("maps write failure %#", async (failure) => {
  mocks.writeBrief.mockRejectedValue(failure);
  await expect(saveSharedContextAction({ project_slug: "acme", content: "brief" })).resolves.toEqual({
    ok: false,
    error: failure instanceof Error ? failure.message : failure,
  });
});
