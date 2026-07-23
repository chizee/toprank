// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => ({
  events: [],
  sendingChat: true,
  remoteTurnActive: false,
  openTurn: null,
  turnStartedAt: 1_800_000_000_000,
  pendingUserMsg: null,
  pendingAssistant: "The answer is still streaming.",
  pendingTools: [],
  pendingError: null,
  pendingLifecycle: null,
  send: vi.fn(),
  stopTurn: vi.fn(),
  clearLocal: vi.fn(),
}));

vi.mock("@/components/chat/use-chat-stream", () => ({
  useChatStream: () => stream,
}));

import { LiveTranscript } from "@/components/live-transcript";

describe("LiveTranscript streaming layout", () => {
  it("keeps the writing status close to the streamed answer", () => {
    render(
      <LiveTranscript
        projectSlug="project"
        agentSlug="goal-1"
        agentDisplayName="Growth goal"
        threadId="main"
        initialEvents={[]}
        initialCursor={0}
      />,
    );

    const answerItem = screen
      .getByText("The answer is still streaming.")
      .closest("li");
    const statusItem = screen
      .getByRole("status", {
        name: "Writing the response",
      })
      .closest("li");

    expect(answerItem?.nextElementSibling).toBe(statusItem);
    expect(statusItem).toHaveAttribute("data-live-working-status");
    expect(statusItem).toHaveClass("!mt-2");
    expect(statusItem).not.toHaveTextContent("Growth goal");
  });
});
