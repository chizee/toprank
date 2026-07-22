// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GOAL_DRAG_TYPE, SidebarGoalGroup } from "@/components/sidebar-goal-group";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";

// Mock at the server-action boundary, per repo test conventions.
const moveGoal = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/goal-groups", () => ({
  moveGoalToGroupAction: moveGoal,
  renameGoalGroupAction: vi.fn(),
  deleteGoalGroupAction: vi.fn(),
}));

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

beforeAll(() => {
  // SidebarProvider's useIsMobile needs matchMedia, which jsdom lacks.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

beforeEach(() => {
  moveGoal.mockReset();
  refresh.mockReset();
  window.localStorage.clear();
});

function renderGroup() {
  return render(
    <SidebarProvider>
      <SidebarMenu>
        <SidebarGoalGroup
          groupId="g1"
          name="Ads MCP reliability"
          href="/p/groups/g1"
        >
          <li>member goal row</li>
        </SidebarGoalGroup>
      </SidebarMenu>
    </SidebarProvider>,
  );
}

describe("SidebarGoalGroup", () => {
  it("matches goal rows with a trailing disclosure instead of a dot or count", () => {
    renderGroup();
    const header = screen.getByRole("button", { name: /^ads mcp reliability/i });
    const label = screen.getByText("Ads MCP reliability");
    const chevron = header.querySelector("[data-group-chevron]");

    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header.querySelector(".ns-dot")).toBeNull();
    expect(label.nextElementSibling).toBe(chevron);
    expect(chevron).toHaveClass("rotate-90");
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(screen.getByText("member goal row")).toBeVisible();
  });

  it("keeps nested goal actions on the parent row's right edge", () => {
    renderGroup();
    const sublist = screen.getByText("member goal row").closest("ul");
    expect(sublist).toHaveClass("mr-0", "pr-0");
  });

  it("collapses on header click without unmounting members, and persists", () => {
    renderGroup();
    const header = screen.getByRole("button", { name: /^ads mcp reliability/i });
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header.querySelector("[data-group-chevron]")).not.toHaveClass("rotate-90");
    // Hidden, not removed — member dialog state must survive collapse.
    expect(screen.getByText("member goal row")).not.toBeVisible();
    expect(window.localStorage.getItem("notfair.rail.group.g1.collapsed")).toBe("1");
    fireEvent.click(header);
    expect(screen.getByText("member goal row")).toBeVisible();
    expect(window.localStorage.getItem("notfair.rail.group.g1.collapsed")).toBeNull();
  });

  it("moves a dropped goal into the group", async () => {
    moveGoal.mockResolvedValue({ ok: true });
    renderGroup();
    const item = screen.getByRole("button", { name: /^ads mcp reliability/i })
      .closest("li")!;
    fireEvent.drop(item, {
      dataTransfer: {
        types: [GOAL_DRAG_TYPE],
        getData: (type: string) => (type === GOAL_DRAG_TYPE ? "goal-9" : ""),
      },
    });
    await waitFor(() => expect(moveGoal).toHaveBeenCalledWith("goal-9", "g1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
