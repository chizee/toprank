// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  GoalsBoard,
  type BoardGoal,
  type GoalDashboardSection,
} from "./goals-board";

function goal(overrides: Partial<BoardGoal>): BoardGoal {
  return {
    id: "g1",
    href: "/proj/goals/goal-1",
    label: "Goal one",
    statement: "Do the thing",
    status: "active",
    status_reason: null,
    metric_name: "Clicks",
    current_value: 5,
    target_value: 10,
    metric_direction: "increase",
    mode: "achieve",
    tick_count: 3,
    pinned: false,
    updated_at: "2026-07-10T00:00:00.000Z",
    snapshots: [1, 3, 5],
    ...overrides,
  };
}

function section(overrides: Partial<GoalDashboardSection>): GoalDashboardSection {
  return {
    id: "group-1",
    name: "Acquisition",
    description: "Goals that grow qualified demand.",
    href: "/proj/groups/group-1",
    goals: [],
    ...overrides,
  };
}

describe("GoalsBoard", () => {
  it("renders group sections with every goal's metric history and destination", () => {
    render(
      <GoalsBoard
        sections={[
          section({
            goals: [
              goal({
                id: "clicks",
                href: "/proj/goals/clicks",
                label: "Organic clicks +30%",
                current_value: 76,
                target_value: 77,
                snapshots: [61, 69, 76],
              }),
              goal({
                id: "errors",
                href: "/proj/goals/errors",
                label: "Errors under 2%",
                metric_direction: "decrease",
                mode: "maintain",
                current_value: 1.82,
                target_value: 2,
                snapshots: [3.4, 2.5, 1.82],
              }),
            ],
          }),
        ]}
      />,
    );

    const group = screen.getByRole("region", { name: "Acquisition" });
    expect(within(group).getByRole("link", { name: "Open group" })).toHaveAttribute(
      "href",
      "/proj/groups/group-1",
    );

    const clicks = within(group).getByRole("link", { name: /^Open Organic clicks \+30%/ });
    expect(clicks).toHaveAttribute("href", "/proj/goals/clicks");
    expect(within(clicks).getByText("76")).toBeTruthy();
    expect(within(clicks).getByText("target ≥ 77")).toBeTruthy();
    expect(
      within(clicks).getByRole("img", { name: /Metric trend: 61 → 76/ }),
    ).toHaveStyle({ height: "76px" });

    const errors = within(group).getByRole("link", { name: /^Open Errors under 2%/ });
    expect(within(errors).getByText("hold ≤ 2")).toBeTruthy();
    expect(within(errors).getByText("on target")).toBeTruthy();
  });

  it("keeps pinned goals first and closed goals behind live goals", () => {
    render(
      <GoalsBoard
        sections={[
          section({
            href: null,
            goals: [
              goal({ id: "closed", label: "Closed", status: "killed" }),
              goal({ id: "live", label: "Live", updated_at: "2026-07-20T00:00:00.000Z" }),
              goal({ id: "pinned", label: "Pinned", pinned: true }),
            ],
          }),
        ]}
      />,
    );

    const links = within(screen.getByRole("region", { name: "Acquisition" }))
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label")?.split(",")[0]);
    expect(links).toEqual(["Open Pinned", "Open Live", "Open Closed"]);
  });

  it("shows measured and unmeasured history empty states", () => {
    render(
      <GoalsBoard
        sections={[
          section({
            goals: [
              goal({ id: "one-reading", snapshots: [5] }),
              goal({
                id: "intake",
                label: "New goal",
                metric_name: null,
                current_value: null,
                target_value: null,
                snapshots: [],
                statement: "Measure signups from the new landing page.",
                status: "intake",
              }),
            ],
          }),
        ]}
      />,
    );

    expect(screen.getByText("Trend appears after the next reading")).toBeTruthy();
    expect(screen.getByText("Measure signups from the new landing page.")).toBeTruthy();
    expect(screen.getByText("Main metric is being defined")).toBeTruthy();
  });

  it("keeps empty groups visible and actionable", () => {
    render(<GoalsBoard sections={[section({ goals: [] })]} />);
    expect(screen.getByText("No goals in this group yet.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open group" })).toHaveAttribute(
      "href",
      "/proj/groups/group-1",
    );
  });
});
