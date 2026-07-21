// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GoalProgressChart, type ChartAction, type ChartFailure, type ChartPoint } from "./goal-progress-chart";

const now = Date.UTC(2026, 0, 10);
const points: ChartPoint[] = [
  { t: now - 3_000, v: 1000, source: "backfill" },
  { t: now - 1_000, v: 1250.25, source: "live" },
];
const actions: ChartAction[] = [
  { t: now - 2_000, kind: "change", label: "Ship page", expected: "+10%", observed: "+12%", reviewUntil: now + 5_000 },
  { t: now - 1_500, kind: "change", label: "Wait", expected: "+5%", observed: null, reviewUntil: now + 2_000 },
];
const failures: ChartFailure[] = [{ t: now - 500, error: "API offline" }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => vi.useRealTimers());

it("shows the empty state until there are two readings", () => {
  const { rerender } = render(
    <GoalProgressChart points={[]} actions={[]} failures={[]} target={null} baseline={null} deadline={null} />,
  );
  expect(screen.getByText(/chart appears after a couple of readings/)).toBeInTheDocument();
  rerender(<GoalProgressChart points={[points[0]!]} actions={[]} failures={[]} target={null} baseline={null} deadline={null} />);
  expect(screen.getByText(/chart appears/)).toBeInTheDocument();
});

it("renders metric, references, action windows, failures, and a deadline", () => {
  const { container } = render(
    <GoalProgressChart
      points={points}
      actions={actions}
      failures={failures}
      target={1500}
      baseline={1000}
      deadline={now - 250}
    />,
  );
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Metric over time. Latest 1.3k, target 1.5k.");
  expect(screen.getByText("target 1.5k")).toBeInTheDocument();
  expect(screen.getByText("⚑ deadline")).toBeInTheDocument();
  expect(screen.getByText("✕")).toBeInTheDocument();
  expect(container.querySelectorAll("svg rect").length).toBeGreaterThan(2);
  expect(container.querySelector("svg path[d^='M']")).toBeInTheDocument();
});

it("handles a flat series by adding vertical padding", () => {
  render(
    <GoalProgressChart
      points={[{ ...points[0]!, v: 7 }, { ...points[1]!, v: 7 }]}
      actions={[]}
      failures={[]}
      target={null}
      baseline={null}
      deadline={now + 50_000}
    />,
  );
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Metric over time. Latest 7.");
  expect(screen.queryByText("⚑ deadline")).not.toBeInTheDocument();
});

it("shows nearest point details and clears a distant hover", () => {
  render(<GoalProgressChart points={points} actions={[]} failures={[]} target={null} baseline={null} deadline={null} />);
  const svg = screen.getByRole("img");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, width: 340, top: 0, height: 170 } as DOMRect);
  fireEvent.mouseMove(svg, { clientX: 34 });
  expect(screen.getAllByText("1.0k")).toHaveLength(2);
  expect(screen.getByText(/history/)).toBeInTheDocument();
  fireEvent.mouseMove(svg, { clientX: 330 });
  fireEvent.mouseLeave(svg);
  expect(screen.queryByText(/history/)).not.toBeInTheDocument();
});

it("shows observed, measuring, and failure tooltips", () => {
  const { container } = render(
    <GoalProgressChart points={points} actions={actions} failures={failures} target={null} baseline={null} deadline={null} />,
  );
  const hoverGroups = container.querySelectorAll("g.cursor-help");
  fireEvent.mouseEnter(hoverGroups[0]!);
  expect(screen.getByText(/Ship page/)).toBeInTheDocument();
  expect(screen.getByText(/observed: \+12%/)).toBeInTheDocument();
  fireEvent.mouseLeave(hoverGroups[0]!);
  fireEvent.mouseEnter(hoverGroups[1]!);
  expect(screen.getByText(/measuring until/)).toBeInTheDocument();
  fireEvent.mouseEnter(hoverGroups[2]!);
  expect(screen.getByText("API offline")).toBeInTheDocument();
  fireEvent.mouseLeave(hoverGroups[2]!);
  expect(screen.queryByText("API offline")).not.toBeInTheDocument();
});
