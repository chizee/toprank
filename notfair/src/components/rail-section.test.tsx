// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RailSection } from "@/components/rail-section";

describe("RailSection", () => {
  it("shows the body, title, and count by default", () => {
    render(
      <RailSection title="Checks" count={12}>
        <p>diary rows</p>
      </RailSection>,
    );
    expect(screen.getByRole("button", { name: /checks/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("(12)")).toBeInTheDocument();
    expect(screen.getByText("diary rows")).toBeVisible();
  });

  it("collapses on click without unmounting the body (state survives)", () => {
    render(
      <RailSection title="Open actions">
        <p>action rows</p>
      </RailSection>,
    );
    const toggle = screen.getByRole("button", { name: /open actions/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Hidden, not removed — client state inside the body must survive.
    expect(screen.getByText("action rows")).not.toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByText("action rows")).toBeVisible();
  });

  it("collapses independently from neighboring sections", () => {
    render(
      <>
        <RailSection title="Goal">
          <p>Increase qualified traffic</p>
        </RailSection>
        <RailSection title="Main metric">
          <p>Organic sessions</p>
        </RailSection>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Goal" }));

    expect(screen.getByText("Increase qualified traffic")).not.toBeVisible();
    expect(screen.getByText("Organic sessions")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Main metric" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});
