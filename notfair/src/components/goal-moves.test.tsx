// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GoalMoves, parseResourceLabel, type MoveRow } from "./goal-moves";

// Mock at the server-action / router boundaries, per repo test conventions.
const releaseLock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/server/actions/goals", () => ({ releaseLockAction: releaseLock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function move(overrides: Partial<MoveRow>): MoveRow {
  return {
    action_id: "a1",
    kind: "mutation",
    description: "Open one listing PR to acme/awesome-list.",
    resources: ["github:acme/awesome-list"],
    made_at: new Date(Date.now() - 3600_000).toISOString(),
    observe_until: new Date(Date.now() + 3 * 3600_000).toISOString(),
    ...overrides,
  };
}

describe("parseResourceLabel", () => {
  it("splits scope, name, and humanizes the fragment", () => {
    expect(parseResourceLabel("local:gh_leads.db#the-nine-blank-pr_url-rows")).toEqual({
      scope: "local",
      name: "gh_leads.db",
      detail: "the nine blank pr_url rows",
      href: null,
    });
  });

  it("links github owner/repo resources", () => {
    expect(parseResourceLabel("github:acme/awesome-list").href).toBe(
      "https://github.com/acme/awesome-list",
    );
  });

  it("keeps multi-colon names and unscoped labels intact", () => {
    expect(parseResourceLabel("xads:campaign:ol2b7").name).toBe("campaign:ol2b7");
    expect(parseResourceLabel("just-a-label").scope).toBeNull();
  });
});

describe("GoalMoves", () => {
  it("frames an observing move as done, with resources and the window end", () => {
    render(<GoalMoves moves={[move({})]} nextCheckAt={null} />);
    expect(screen.getByText(/Done — observing the effect/)).toBeInTheDocument();
    expect(screen.getByText("✓ done")).toBeInTheDocument();
    expect(screen.getByText(/made 1h ago/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "acme/awesome-list" }).getAttribute("href"),
    ).toBe("https://github.com/acme/awesome-list");
    expect(screen.getByText(/observation ends in 3h ·/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("queues an expired-window move for the next check", () => {
    render(
      <GoalMoves
        moves={[move({ observe_until: new Date(Date.now() - 60_000).toISOString() })]}
        nextCheckAt="2026-07-17T16:00:00.000Z"
      />,
    );
    expect(screen.getByText(/Done — outcome check queued/)).toBeInTheDocument();
    expect(
      screen.getByText(/records what actually happened at its next check ·/),
    ).toBeInTheDocument();
    // No unlock button once the window is over.
    expect(screen.queryByRole("button", { name: /unlock/i })).toBeNull();
  });

  it("shows windowless research as a note, not a done-badge", () => {
    render(
      <GoalMoves
        moves={[move({ kind: "research", observe_until: null, resources: [] })]}
        nextCheckAt={null}
      />,
    );
    expect(screen.getByText(/Notes & decisions/)).toBeInTheDocument();
    expect(screen.getByText("research")).toBeInTheDocument();
    expect(screen.queryByText("✓ done")).toBeNull();
  });

  it("shows the full description untruncated", () => {
    const long = "A".repeat(400);
    render(<GoalMoves moves={[move({ description: long })]} nextCheckAt={null} />);
    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it("unlocks an observing move via the server action", () => {
    render(<GoalMoves moves={[move({ action_id: "a9" })]} nextCheckAt={null} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    expect(releaseLock).toHaveBeenCalledWith("a9");
  });
});
