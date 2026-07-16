// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoalContextDialog } from "@/components/goal-context-dialog";

// Mock at the server-action boundary, per repo test conventions.
const getContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/context", () => ({
  getGoalContextAction: getContext,
}));

const props = {
  projectSlug: "proj",
  agentSlug: "goal-1",
  agentId: "agent-1",
  threadId: "tick-7",
  models: [{ value: "opus", label: "Opus", context_window: 1000 }],
};

function contextOf(totalTokens: number) {
  return {
    ok: true,
    total_tokens: totalTokens,
    chunks: [
      {
        key: "identity",
        label: "Agent instructions",
        group: "instructions",
        chars: totalTokens * 4,
        tokens: totalTokens,
        content: "You are goal-1.",
        format: "markdown",
      },
    ],
  };
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /context/i }));
  await screen.findByText(/agent instructions/i);
}

beforeEach(() => getContext.mockReset());

describe("GoalContextDialog window pressure", () => {
  it("stays quiet while the window has comfortable headroom", async () => {
    getContext.mockResolvedValueOnce(contextOf(500)); // 50% of 1000
    render(<GoalContextDialog {...props} />);
    await openDialog();
    expect(screen.queryByText(/approaching the window/i)).toBeNull();
    expect(screen.getByText(/50\.0% used/)).toBeInTheDocument();
  });

  it("explains auto-compaction when usage nears the window", async () => {
    getContext.mockResolvedValueOnce(contextOf(850)); // 85% of 1000
    render(<GoalContextDialog {...props} />);
    await openDialog();
    expect(screen.getByText(/approaching the window/i)).toBeInTheDocument();
    expect(screen.getByText(/automatically compacts/i)).toBeInTheDocument();
  });

  it("reports an outgrown window with an honest >100% figure", async () => {
    getContext.mockResolvedValueOnce(contextOf(1250)); // 125% of 1000
    render(<GoalContextDialog {...props} />);
    await openDialog();
    expect(screen.getByText(/outgrown the window/i)).toBeInTheDocument();
    expect(screen.getByText(/125\.0% used/)).toBeInTheDocument();
  });
});
