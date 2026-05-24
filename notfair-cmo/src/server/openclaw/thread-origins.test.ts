import { describe, expect, it } from "vitest";

import {
  isTaskOrCronSession,
  pickLatestChatSession,
} from "./thread-origins";

describe("isTaskOrCronSession", () => {
  it("returns true for cron labels", () => {
    expect(
      isTaskOrCronSession("cron:7f879fba:run:abc", new Set()),
    ).toBe(true);
  });

  it("returns true when the label matches a known task thread_id", () => {
    const taskIds = new Set(["task-thread-uuid"]);
    expect(isTaskOrCronSession("task-thread-uuid", taskIds)).toBe(true);
  });

  it("returns false for plain chat labels", () => {
    expect(isTaskOrCronSession("random-uuid", new Set())).toBe(false);
    expect(isTaskOrCronSession("main", new Set())).toBe(false);
  });

  it("does not treat 'cron' as cron prefix without the colon", () => {
    // Defensive: a chat thread that happens to start with the letters
    // "cron" but isn't an OpenClaw cron-run label should not be filtered.
    expect(isTaskOrCronSession("crontab-discussion", new Set())).toBe(false);
  });
});

describe("pickLatestChatSession", () => {
  // listSessionsForAgent returns newest-first; tests mirror that order.
  const taskIds = new Set(["task-1-thread"]);

  it("returns the first chat session, skipping leading task/cron rows", () => {
    const sessions = [
      { label: "cron:abc:run:1" }, // cron — skip
      { label: "task-1-thread" }, // task — skip
      { label: "uuid-newest-chat" }, // pick this
      { label: "uuid-older-chat" },
    ];
    expect(pickLatestChatSession(sessions, taskIds)?.label).toBe(
      "uuid-newest-chat",
    );
  });

  it("returns undefined when every session is a task or cron", () => {
    const sessions = [
      { label: "cron:abc:run:1" },
      { label: "task-1-thread" },
    ];
    expect(pickLatestChatSession(sessions, taskIds)).toBeUndefined();
  });

  it("returns undefined for an empty list (caller mints a fresh id)", () => {
    expect(pickLatestChatSession([], taskIds)).toBeUndefined();
  });

  it("works with the OpenClawSession shape, not just bare labels", () => {
    // Generic over { label: string } — calling with the full session
    // shape returns the same object so the caller can read sessionId.
    const sessions = [
      {
        label: "task-1-thread",
        sessionId: "internal-1",
        sessionKey: "agent:x:task-1-thread",
        lastInteractionAt: 200,
        pending: false,
      },
      {
        label: "chat-uuid",
        sessionId: "internal-2",
        sessionKey: "agent:x:chat-uuid",
        lastInteractionAt: 100,
        pending: false,
      },
    ];
    const picked = pickLatestChatSession(sessions, taskIds);
    expect(picked?.sessionId).toBe("internal-2");
  });
});
