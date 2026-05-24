// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const setSkillEnabledAction = vi.fn();
const toast = {
  success: vi.fn(),
  error: vi.fn(),
};

vi.mock("@/server/actions/skills", () => ({
  setSkillEnabledAction: (...args: unknown[]) => setSkillEnabledAction(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toast.success(...args),
    error: (...args: unknown[]) => toast.error(...args),
  },
}));

import { SkillsList } from "./skills-list";

type Skill = Parameters<typeof SkillsList>[0]["skills"][number];

function skill(over: Partial<Skill> = {}): Skill {
  return {
    name: "test-skill",
    description: "A test skill",
    source: "user",
    bundled: false,
    filePath: "/x",
    baseDir: "/x",
    skillKey: "test-skill",
    emoji: "🧪",
    always: false,
    disabled: false,
    eligible: true,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    userInvocable: true,
    commandVisible: true,
    ...over,
  } as Skill;
}

const skills: Skill[] = [
  skill({ skillKey: "enabled-a", name: "enabled-a", disabled: false }),
  skill({ skillKey: "enabled-b", name: "enabled-b", disabled: false, bundled: true }),
  skill({ skillKey: "disabled-a", name: "disabled-a", disabled: true }),
  skill({
    skillKey: "init",
    name: "init",
    always: true,
    disabled: false,
  }),
  skill({
    skillKey: "needs-setup",
    name: "needs-setup",
    disabled: false,
    eligible: false,
  }),
];

beforeEach(() => {
  setSkillEnabledAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SkillsList", () => {
  it("renders one row per skill in the 'all' filter (default)", () => {
    render(<SkillsList skills={skills} agentSlug="cmo" />);
    for (const s of skills) {
      expect(screen.getByText(s.name)).toBeInTheDocument();
    }
  });

  it("shows filter tabs with per-bucket counts", () => {
    render(<SkillsList skills={skills} agentSlug="cmo" />);
    expect(screen.getByRole("tab", { name: /All\s*5/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Enabled\s*4/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Disabled\s*1/i })).toBeInTheDocument();
  });

  it("narrows to enabled skills when the Enabled tab is clicked", () => {
    render(<SkillsList skills={skills} agentSlug="cmo" />);
    fireEvent.click(screen.getByRole("tab", { name: /Enabled\s*4/i }));
    expect(screen.queryByText("disabled-a")).not.toBeInTheDocument();
    expect(screen.getByText("enabled-a")).toBeInTheDocument();
  });

  it("narrows to disabled skills when the Disabled tab is clicked", () => {
    render(<SkillsList skills={skills} agentSlug="cmo" />);
    fireEvent.click(screen.getByRole("tab", { name: /Disabled\s*1/i }));
    expect(screen.getByText("disabled-a")).toBeInTheDocument();
    expect(screen.queryByText("enabled-a")).not.toBeInTheDocument();
  });

  it("shows the empty-state when a filter yields no skills", () => {
    render(<SkillsList skills={[]} agentSlug="cmo" />);
    expect(screen.getByText(/no skills match this filter/i)).toBeInTheDocument();
  });

  it("renders the 'bundled' badge on bundled skills", () => {
    render(<SkillsList skills={skills} agentSlug="cmo" />);
    expect(screen.getByText("bundled")).toBeInTheDocument();
  });

  it("renders the 'always-on' badge and disables the toggle on always skills", () => {
    render(<SkillsList skills={skills} agentSlug="cmo" />);
    expect(screen.getByText("always-on")).toBeInTheDocument();
    const row = screen.getByText("init").closest("li");
    const btn = row?.querySelector("button");
    expect(btn).toBeDisabled();
  });

  it("renders the 'needs setup' badge when enabled but not eligible", () => {
    render(<SkillsList skills={skills} agentSlug="cmo" />);
    expect(screen.getByText("needs setup")).toBeInTheDocument();
  });

  it("toggles a skill off when the user clicks Enabled and toasts success", async () => {
    setSkillEnabledAction.mockResolvedValue({ ok: true });
    render(<SkillsList skills={[skill({ skillKey: "k", name: "k" })]} agentSlug="cmo" />);
    const btn = screen.getByRole("button", { name: /enabled/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(setSkillEnabledAction).toHaveBeenCalledWith("k", false, "cmo"),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Disabled k"),
    );
  });

  it("toggles a disabled skill on and toasts success", async () => {
    setSkillEnabledAction.mockResolvedValue({ ok: true });
    render(
      <SkillsList
        skills={[skill({ skillKey: "k", name: "k", disabled: true })]}
        agentSlug="cmo"
      />,
    );
    const btn = screen.getByRole("button", { name: /enable/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(setSkillEnabledAction).toHaveBeenCalledWith("k", true, "cmo"),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Enabled k"));
  });

  it("reverts the optimistic state and toasts an error on failure", async () => {
    setSkillEnabledAction.mockResolvedValue({ ok: false, error: "no" });
    render(<SkillsList skills={[skill({ skillKey: "k", name: "k" })]} agentSlug="cmo" />);
    const btn = screen.getByRole("button", { name: /enabled/i });
    fireEvent.click(btn);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("no"));
    // After revert: still in the "Enabled" visual state.
    expect(screen.getByRole("button", { name: /enabled/i })).toBeInTheDocument();
  });
});
