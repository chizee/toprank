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
});
