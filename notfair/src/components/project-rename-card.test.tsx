// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProjectRenameCard } from "@/components/project-rename-card";

// Mock at the server-action boundary, per repo test conventions.
const renameFull = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/projects", () => ({
  renameProjectFullAction: renameFull,
}));

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function renderCard(over: Partial<React.ComponentProps<typeof ProjectRenameCard>> = {}) {
  return render(
    <ProjectRenameCard
      currentSlug="acme"
      currentDisplayName="Acme"
      {...over}
    />,
  );
}

describe("ProjectRenameCard", () => {
  it("starts with the display name and a disabled save when nothing changed", () => {
    renderCard();
    expect(screen.getByLabelText("Display name")).toHaveValue("Acme");
    expect(
      screen.getByText("Same slug — only the display name changes."),
    ).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Save name" });
    expect(btn).toBeDisabled();
  });

  it("previews a slug change and switches the primary action to rename", () => {
    renderCard();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Acme Rockets" },
    });
    // Slug-change preview names both the old and derived slug.
    expect(screen.getByText(/Slug changes from/)).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("acme-rockets")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rename workspace" }),
    ).toBeEnabled();
  });

  it("flags an unslug-able name and blocks saving", () => {
    renderCard();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "!!!" },
    });
    expect(screen.getByText(/Invalid name:/)).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("enables a display-name-only save when the slug is unchanged", () => {
    renderCard();
    // Same slug ("acme") but different display name.
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "ACME" },
    });
    expect(
      screen.getByText("Same slug — only the display name changes."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled();
  });

  it("reports a full rename with relocated agents on success", async () => {
    renameFull.mockResolvedValue({
      ok: true,
      data: {
        display_name: "Acme Rockets",
        full_rename: true,
        agents_relocated: ["a1", "a2"],
        agents_failed: [],
      },
    });
    renderCard();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Acme Rockets" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    await waitFor(() => {
      expect(renameFull).toHaveBeenCalledWith({
        current_slug: "acme",
        new_display_name: "Acme Rockets",
      });
      expect(toastSuccess).toHaveBeenCalledWith(
        'Renamed to "Acme Rockets" (2 agents moved)',
      );
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("notes failed agent relocations in the success toast", async () => {
    renameFull.mockResolvedValue({
      ok: true,
      data: {
        display_name: "Acme Rockets",
        full_rename: true,
        agents_relocated: ["a1"],
        agents_failed: [{ agent_id: "a2", error: "locked" }],
      },
    });
    renderCard();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Acme Rockets" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Renamed to "Acme Rockets" (1 agents moved, 1 failed)',
      ),
    );
  });

  it("uses the plain toast for a display-name-only rename", async () => {
    renameFull.mockResolvedValue({
      ok: true,
      data: {
        display_name: "ACME",
        full_rename: false,
        agents_relocated: [],
        agents_failed: [],
      },
    });
    renderCard();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "ACME" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Renamed to "ACME"'),
    );
  });

  it("surfaces a server error and does not refresh", async () => {
    renameFull.mockResolvedValue({ ok: false, error: "slug taken" });
    renderCard();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Acme Rockets" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("slug taken"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("syncs the field when the current display name prop changes", () => {
    const { rerender } = renderCard();
    rerender(
      <ProjectRenameCard currentSlug="acme" currentDisplayName="Renamed Co" />,
    );
    expect(screen.getByLabelText("Display name")).toHaveValue("Renamed Co");
  });
});
