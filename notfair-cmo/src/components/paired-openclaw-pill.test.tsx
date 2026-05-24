// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const discoverGateway = vi.fn();

vi.mock("@/server/openclaw/gateway-client", () => ({
  discoverGateway: () => discoverGateway(),
}));

import { PairedOpenclawPill } from "./paired-openclaw-pill";

afterEach(() => cleanup());

beforeEach(() => {
  discoverGateway.mockReset();
});

describe("PairedOpenclawPill", () => {
  it("renders the pill linking to the dashboard with a token fragment when the gateway is paired", () => {
    discoverGateway.mockReturnValue({
      url: "ws://127.0.0.1:7788",
      token: "secret/token+abc",
      configFile: "/tmp/openclaw.json",
    });
    render(<PairedOpenclawPill />);
    const link = screen.getByRole("link");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      `http://127.0.0.1:7788/#token=${encodeURIComponent("secret/token+abc")}`,
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("title", "Open OpenClaw dashboard");
    expect(screen.getByText("Paired OpenClaw")).toBeInTheDocument();
  });

  it("rewrites a wss:// gateway url to https:// for the dashboard link", () => {
    discoverGateway.mockReturnValue({
      url: "wss://gateway.example:8443",
      token: "t",
      configFile: "/tmp/openclaw.json",
    });
    render(<PairedOpenclawPill />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toMatch(/^https:\/\/gateway\.example:8443\/#token=t$/);
  });

  it("omits the token fragment when the gateway has no token", () => {
    discoverGateway.mockReturnValue({
      url: "ws://127.0.0.1:7788",
      configFile: "/tmp/openclaw.json",
    });
    render(<PairedOpenclawPill />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "http://127.0.0.1:7788/");
    expect(link.getAttribute("href")).not.toContain("#token=");
  });

  it("renders nothing when discoverGateway throws (no OpenClaw config)", () => {
    discoverGateway.mockImplementation(() => {
      throw new Error("config not found");
    });
    const { container } = render(<PairedOpenclawPill />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
