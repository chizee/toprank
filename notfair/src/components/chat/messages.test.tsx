// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolGroup } from "./messages";
import type { ToolEntry } from "./transcript-model";

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
    expect(list).toHaveClass("max-h-64", "overflow-y-auto");
    expect(list.querySelectorAll("[data-tool-row]")).toHaveLength(3);
    expect(list.querySelector("[data-tool-row] .ml-5")).toBeNull();
  });
});
