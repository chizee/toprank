// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoalNeedsYou } from "@/components/goal-needs-you";

// Mock at the server-action boundary, per repo test conventions.
const markHandled = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/goals", () => ({
  markUserActionHandledAction: markHandled,
}));

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const ITEMS = [
  {
    action_id: "a1",
    ask: "Replace the production OPENAI_API_KEY with one from an active project.",
    tick_number: 43,
    raised_at: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    action_id: "a2",
    ask: "Grant the Meta app image-upload access and re-authorize.",
    tick_number: null,
    raised_at: new Date().toISOString(),
  },
];

beforeEach(() => {
  markHandled.mockReset();
  refresh.mockReset();
});

describe("GoalNeedsYou", () => {
  it("renders nothing when there are no open asks", () => {
    const { container } = render(<GoalNeedsYou items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every ask with its raised context", () => {
    render(<GoalNeedsYou items={ITEMS} />);
    expect(screen.getByRole("region", { name: /needs you: 2 actions/i })).toBeInTheDocument();
    expect(screen.getByText(/OPENAI_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/raised 1h ago · check #43/)).toBeInTheDocument();
    expect(screen.getByText(/Meta app image-upload access/)).toBeInTheDocument();
  });

  it("marks an ask handled and refreshes", async () => {
    markHandled.mockResolvedValue({ ok: true });
    render(<GoalNeedsYou items={ITEMS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /mark handled/i })[0]!);
    await waitFor(() => expect(markHandled).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
