// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoalCompletionDialog } from "@/components/goal-completion-dialog";

const archiveGoal = vi.hoisted(() => vi.fn());
const continueGoal = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/goals", () => ({
  archiveCompletedGoalAction: archiveGoal,
  continueCompletedGoalAction: continueGoal,
}));

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const PROPS = {
  goalId: "goal-1",
  label: "Qualified visits → 100",
  metricName: "Qualified visits",
  currentValue: 112,
  targetValue: 100,
  metricDirection: "increase" as const,
  completionReason: "The verified metric reached 112.",
  completedAt: "2026-07-22T18:00:00.000Z",
  goalHref: "/acme/goals/goal-1",
};

function renderDialog() {
  render(
    <GoalCompletionDialog
      {...PROPS}
      trigger={<button type="button">Completed</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Completed" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  archiveGoal.mockResolvedValue({ ok: true });
  continueGoal.mockResolvedValue({ ok: true });
});

describe("GoalCompletionDialog", () => {
  it("celebrates the measured result and keeps every next step explicit", () => {
    renderDialog();

    expect(screen.getByRole("heading", { name: "You did it." })).toBeInTheDocument();
    expect(screen.getByText("112")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set a new target/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /archive goal/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view the full story/i })).toHaveAttribute(
      "href",
      "/acme/goals/goal-1",
    );
  });

  it("continues the same goal with a validated next milestone", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /set a new target/i }));
    expect(
      screen.getByRole("heading", { name: /what’s the next milestone/i }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New target"), {
      target: { value: "150" },
    });
    expect(screen.getByLabelText("Goal name")).toHaveValue(
      "Qualified visits → 150",
    );
    fireEvent.change(screen.getByLabelText(/Deadline/), {
      target: { value: "2030-12-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start next milestone/i }));

    await waitFor(() =>
      expect(continueGoal).toHaveBeenCalledWith("goal-1", {
        target_value: 150,
        deadline: "2030-12-31",
        label: "Qualified visits → 150",
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("archives the achievement without conflating archive with delete", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /archive goal/i }));

    await waitFor(() => expect(archiveGoal).toHaveBeenCalledWith("goal-1"));
    expect(continueGoal).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
