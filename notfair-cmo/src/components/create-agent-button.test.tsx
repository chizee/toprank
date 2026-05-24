// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const dialogCalls: Array<{ open: boolean; projectSlug: string }> = [];

vi.mock("./create-agent-dialog", () => ({
  CreateAgentDialog: ({
    open,
    onOpenChange,
    projectSlug,
  }: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    projectSlug: string;
  }) => {
    dialogCalls.push({ open, projectSlug });
    return open ? (
      <div data-testid="dialog-stub">
        dialog-open-for-{projectSlug}
        <button onClick={() => onOpenChange(false)}>close</button>
      </div>
    ) : null;
  },
}));

import { CreateAgentButton } from "./create-agent-button";

beforeEach(() => {
  dialogCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("CreateAgentButton", () => {
  it("renders a plus button with an accessible name", () => {
    render(<CreateAgentButton projectSlug="proj" />);
    expect(
      screen.getByRole("button", { name: /create or clone agent/i }),
    ).toBeInTheDocument();
  });

  it("starts with the dialog closed", () => {
    render(<CreateAgentButton projectSlug="proj" />);
    expect(screen.queryByTestId("dialog-stub")).not.toBeInTheDocument();
    expect(dialogCalls.at(-1)?.open).toBe(false);
  });

  it("opens the dialog when the button is clicked", () => {
    render(<CreateAgentButton projectSlug="proj" />);
    fireEvent.click(
      screen.getByRole("button", { name: /create or clone agent/i }),
    );
    expect(screen.getByTestId("dialog-stub")).toBeInTheDocument();
    expect(screen.getByText("dialog-open-for-proj")).toBeInTheDocument();
  });

  it("forwards the projectSlug prop to the dialog", () => {
    render(<CreateAgentButton projectSlug="alpha-beta" />);
    fireEvent.click(
      screen.getByRole("button", { name: /create or clone agent/i }),
    );
    expect(dialogCalls.at(-1)?.projectSlug).toBe("alpha-beta");
  });

  it("closes the dialog when the child fires onOpenChange(false)", () => {
    render(<CreateAgentButton projectSlug="proj" />);
    fireEvent.click(
      screen.getByRole("button", { name: /create or clone agent/i }),
    );
    expect(screen.getByTestId("dialog-stub")).toBeInTheDocument();
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("dialog-stub")).not.toBeInTheDocument();
  });
});
