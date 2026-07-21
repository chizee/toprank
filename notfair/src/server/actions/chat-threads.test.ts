import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  resolveAgentBySlug: vi.fn(),
  getProject: vi.fn(),
  deleteSession: vi.fn(),
  setSessionPinned: vi.fn(),
  setSessionTitle: vi.fn(),
  findSession: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/agent-meta", () => ({ resolveAgentBySlug: mocks.resolveAgentBySlug }));
vi.mock("@/server/db/projects", () => ({ getProject: mocks.getProject }));
vi.mock("@/server/sessions", () => ({
  deleteSession: mocks.deleteSession,
  setSessionPinned: mocks.setSessionPinned,
  setSessionTitle: mocks.setSessionTitle,
}));
vi.mock("@/server/sessions/view", () => ({ findSessionBySessionId: mocks.findSession }));

import { deleteThreadAction, renameThreadAction, setThreadPinnedAction } from "./chat-threads";

const base = { projectSlug: "acme", agentSlug: "goal-1", threadLabel: "thread-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockReturnValue({ slug: "acme", archived_at: null });
  mocks.resolveAgentBySlug.mockResolvedValue({ agent_id: "agent-1" });
  mocks.findSession.mockReturnValue({ sessionKey: "db-session-1" });
});

it("renames, pins, and deletes an owned thread", async () => {
  await expect(renameThreadAction({ ...base, title: "New" })).resolves.toEqual({ ok: true });
  expect(mocks.setSessionTitle).toHaveBeenCalledWith("db-session-1", "New");
  await expect(setThreadPinnedAction({ ...base, pinned: true })).resolves.toEqual({ ok: true });
  expect(mocks.setSessionPinned).toHaveBeenCalledWith("db-session-1", true);
  await expect(deleteThreadAction(base)).resolves.toEqual({ ok: true });
  expect(mocks.deleteSession).toHaveBeenCalledWith("db-session-1");
  expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
});

it.each([null, { slug: "acme", archived_at: "yesterday" }])("rejects missing/archived project %#", async (project) => {
  mocks.getProject.mockReturnValue(project);
  await expect(renameThreadAction({ ...base, title: "New" })).resolves.toEqual({
    ok: false,
    error: "Project not found.",
  });
});

it("rejects unknown agents and threads", async () => {
  mocks.resolveAgentBySlug.mockResolvedValue(null);
  await expect(setThreadPinnedAction({ ...base, pinned: false })).resolves.toEqual({
    ok: false,
    error: "Unknown agent 'goal-1'",
  });
  mocks.resolveAgentBySlug.mockResolvedValue({ agent_id: "agent-1" });
  mocks.findSession.mockReturnValue(null);
  await expect(deleteThreadAction(base)).resolves.toEqual({ ok: false, error: "Thread not found." });
});
