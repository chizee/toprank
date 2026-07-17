// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { GoalsBoard, type BoardGoal } from "./goals-board";

function goal(overrides: Partial<BoardGoal>): BoardGoal {
  return {
    id: "g1",
    href: "/proj/goals/goal-1",
    label: "Goal one",
    statement: "Do the thing",
    status: "active",
    status_reason: null,
    metric_name: "Clicks",
    baseline_value: 0,
    current_value: 5,
    target_value: 10,
    metric_direction: "increase",
    mode: "achieve",
    tick_count: 3,
    pinned: false,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("GoalsBoard", () => {
  it("groups goals into lifecycle columns", () => {
    render(
      <GoalsBoard
        goals={[
          goal({ id: "a", label: "Running goal", status: "active" }),
          goal({ id: "b", label: "Won goal", status: "achieved", status_reason: "target hit" }),
          goal({ id: "c", label: "Draft goal", status: "intake" }),
        ]}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "Running" })).getByText("Running goal"),
    ).toBeTruthy();
    const achieved = screen.getByRole("region", { name: "Achieved" });
    expect(within(achieved).getByText("Won goal")).toBeTruthy();
    expect(within(achieved).getByText("target hit")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Setting up" })).getByText("Draft goal"),
    ).toBeTruthy();
  });

  it("toggling a status chip hides and restores its column", () => {
    render(<GoalsBoard goals={[goal({ status: "active" })]} />);
    const chip = screen.getByRole("button", { name: /Running/ });
    expect(screen.getByRole("region", { name: "Running" })).toBeTruthy();

    fireEvent.click(chip);
    expect(screen.queryByRole("region", { name: "Running" })).toBeNull();

    fireEvent.click(chip);
    expect(screen.getByRole("region", { name: "Running" })).toBeTruthy();
  });

  it("sorts pinned goals to the top of their column", () => {
    render(
      <GoalsBoard
        goals={[
          goal({ id: "old", label: "Older unpinned", created_at: "2026-07-02T00:00:00.000Z" }),
          goal({
            id: "new",
            label: "Newest unpinned",
            created_at: "2026-07-05T00:00:00.000Z",
          }),
          goal({
            id: "pinned",
            label: "Pinned goal",
            pinned: true,
            created_at: "2026-07-01T00:00:00.000Z",
          }),
        ]}
      />,
    );
    const cards = within(screen.getByRole("region", { name: "Running" })).getAllByRole("link");
    expect(cards[0]!.textContent).toContain("Pinned goal");
    expect(cards[1]!.textContent).toContain("Newest unpinned");
  });
});
