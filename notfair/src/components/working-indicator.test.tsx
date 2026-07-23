// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { WorkingIndicator } from "@/components/working-indicator";

describe("WorkingIndicator completed state", () => {
  it("shows only animated text while writing the response", () => {
    const { container } = render(
      <WorkingIndicator
        agentDisplayName="Google Ads errors <2%"
        headline="Writing the response"
        subtitle="Ran query ✓"
        phases={[
          {
            id: "query",
            label: "Ran query",
            state: "done",
          },
        ]}
        elapsedMs={30_000}
        mood="writing"
      />,
    );

    const status = screen.getByRole("status", {
      name: "Writing the response",
    });
    expect(status).toHaveTextContent(/^Writing the response$/);
    expect(status.querySelector(".ns-shimmer-text")).toBeInTheDocument();
    expect(status.querySelector("svg")).toBeNull();
    expect(status.querySelector("ol")).toBeNull();
    expect(screen.queryByText("Google Ads errors <2%")).toBeNull();
    expect(screen.queryByText("Ran query ✓")).toBeNull();
    expect(screen.queryByText("0:30")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("renders a completed turn without live motion or an increasing timer", () => {
    const { container } = render(
      <WorkingIndicator
        agentDisplayName="Growth agent"
        headline="Turn complete"
        subtitle={null}
        phases={[
          {
            id: "unfinished-tool",
            label: "Inspecting data",
            state: "active",
          },
        ]}
        elapsedMs={65_000}
        mood="ended"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Growth agent Turn complete" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Growth agent Turn complete" }),
    ).toHaveAttribute("data-run-state", "complete");
    expect(container.querySelector('[class*="animate-"]')).toBeNull();
    expect(screen.queryByText("1:05")).toBeNull();
  });

  it("keeps an active tool run visibly running with elapsed time", () => {
    render(
      <WorkingIndicator
        agentDisplayName="Growth agent"
        headline="Calling X Ads"
        subtitle="summarizeXAccountSetup"
        phases={[
          {
            id: "x-ads-call",
            label: "Summarize X account setup",
            state: "active",
          },
        ]}
        elapsedMs={65_000}
        mood="tool"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Growth agent Calling X Ads" }),
    ).toHaveAttribute("data-run-state", "running");
    expect(screen.getByText("1:05")).toBeInTheDocument();
    expect(screen.getByText("Summarize X account setup")).toBeInTheDocument();
  });
});
