// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

import { BeamingGlyph, BeamingHeadline } from "./beaming-indicator";

afterEach(() => {
  vi.useRealTimers();
});

describe("BeamingHeadline", () => {
  it("renders a verb and the prefix", () => {
    render(<BeamingHeadline prefix="CMO" />);
    // Status node carries the verb in aria-label so the test doesn't
    // depend on which random verb mounted.
    const node = screen.getByRole("status");
    expect(node).toBeInTheDocument();
    expect(node.getAttribute("aria-label")).toMatch(/\w+…/);
    // Prefix rendered too.
    expect(node.textContent ?? "").toMatch(/CMO/);
  });

  it("rotates the verb on a timer", () => {
    vi.useFakeTimers();
    render(<BeamingHeadline prefix="CMO" />);
    const node = screen.getByRole("status");
    const first = node.getAttribute("aria-label");
    // Advance past the verb interval (2.5s) plus margin.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    const second = node.getAttribute("aria-label");
    // Random cycle picks a different verb each tick, so labels must differ.
    expect(second).not.toBe(first);
  });
});

describe("BeamingGlyph", () => {
  it("renders a glyph by default", () => {
    const { container } = render(<BeamingGlyph />);
    // The glyph is inside the only span we render.
    const span = container.querySelector("span[aria-hidden]");
    expect(span).not.toBeNull();
    expect((span?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("honors an explicit glyph prop", () => {
    const { container } = render(<BeamingGlyph glyph="✶" />);
    expect(container.textContent).toBe("✶");
  });
});
