// @vitest-environment jsdom
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RenderItem, ToolGroup } from "./messages";
import type { RenderedItem, ToolEntry } from "./transcript-model";

const runningTool: ToolEntry = {
  toolCallId: "tool-1",
  name: "shell",
  label: "pwd",
  result: null,
  ok: true,
  done: false,
};

describe("ToolGroup", () => {
  it("stays collapsed by default and preserves a user's expansion when the tool finishes", () => {
    const { container, rerender } = render(
      <ToolGroup tools={[runningTool]} />,
    );
    const details = container.querySelector("details");
    const summary = container.querySelector("summary");

    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary!);
    expect(details).toHaveAttribute("open");

    rerender(
      <ToolGroup
        tools={[
          {
            ...runningTool,
            result: "done",
            done: true,
          },
        ]}
      />,
    );

    expect(container.querySelector("details")).toBe(details);
    expect(details).toHaveAttribute("open");
  });

  it("puts the disclosure control after the activity text and expands a flat scrollable list", () => {
    const { container } = render(
      <ToolGroup
        tools={[
          {
            ...runningTool,
            toolCallId: "edit-1",
            name: "Edit",
            label: "src/page.tsx",
            done: true,
          },
          {
            ...runningTool,
            toolCallId: "read-1",
            name: "Read",
            label: "DESIGN.md",
            done: true,
          },
          {
            ...runningTool,
            toolCallId: "shell-1",
            label: "rg -n ToolGroup src",
            done: true,
          },
        ]}
      />,
    );

    const summary = container.querySelector("summary")!;
    const label = summary.querySelector("[data-tool-summary]")!;
    const toggle = summary.querySelector("[data-tool-toggle]")!;
    const list = container.querySelector("[data-tool-list]")!;

    expect(label).toHaveTextContent("Edited file, read file, ran command");
    expect(label.nextElementSibling).toBe(toggle);
    expect(toggle).toHaveClass("opacity-0");
    expect(summary).toHaveClass("relative");
    expect(list).toHaveClass("max-h-64", "overflow-y-auto");
    expect(list.querySelectorAll("[data-tool-row]")).toHaveLength(3);
    for (const row of list.querySelectorAll("[data-tool-row]")) {
      expect(row).toHaveClass("relative");
    }
    expect(list.querySelector("[data-tool-row] .ml-5")).toBeNull();
  });
});

describe("check prompt disclosure", () => {
  it("lets the user expand the exact prompt that started a check", () => {
    const prompt = [
      "[TICK] Goal heartbeat #49 — 2026-07-21T20:00:00.000Z",
      "",
      "## Metric (measured by the platform just now)",
      "- Lead-form failures: **2**",
    ].join("\n");
    const item: RenderedItem = {
      kind: "user_message",
      key: "tick-prompt",
      body: prompt,
      system: true,
    };

    const { container } = render(<RenderItem item={item} />);
    const details = container.querySelector("details");

    expect(details).not.toHaveAttribute("open");
    const summary = container.querySelector("summary")!;
    expect(summary).toHaveTextContent("View exact prompt");
    expect(summary).toHaveClass("focus-visible:ring-2", "focus-visible:ring-ring");
    const promptMessage = container.querySelector(
      "[data-check-trigger-prompt]",
    ) as HTMLElement;
    expect(
      within(promptMessage).getByRole("heading", {
        level: 2,
        name: "Metric (measured by the platform just now)",
      }),
    ).toBeInTheDocument();
    expect(promptMessage.querySelector("strong")).toHaveTextContent("2");
    expect(container).not.toHaveTextContent("Exact prompt sent to the agent");

    fireEvent.click(container.querySelector("summary")!);
    expect(details).toHaveAttribute("open");
  });
});
