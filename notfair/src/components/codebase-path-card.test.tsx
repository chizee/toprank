// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CodebasePathCard } from "@/components/codebase-path-card";

// Mock at the server-action boundary, per repo test conventions.
const setPath = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/projects", () => ({
  setProjectCodebasePathAction: setPath,
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCard(currentPath: string | null = null) {
  return render(
    <CodebasePathCard projectSlug="acme" currentPath={currentPath} />,
  );
}

describe("CodebasePathCard", () => {
  it("seeds the field from the current path and keeps Save disabled until dirty", () => {
    renderCard("/repo/site");
    expect(screen.getByLabelText("Local codebase folder")).toHaveValue(
      "/repo/site",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Local codebase folder"), {
      target: { value: "/repo/other" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("fills the field from the folder picker result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ ok: true, path: "/picked/dir" }),
      }),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Browse for a folder" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Local codebase folder")).toHaveValue(
        "/picked/dir",
      ),
    );
    expect(fetch).toHaveBeenCalledWith("/api/fs/pick-folder", {
      method: "POST",
    });
  });

  it("silently ignores a cancelled folder pick", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ ok: false, kind: "cancelled" }),
      }),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Browse for a folder" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByLabelText("Local codebase folder")).toHaveValue("");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts the picker's message on an unsupported/error result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ ok: false, kind: "unsupported", message: "no zenity" }),
      }),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Browse for a folder" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("no zenity"));
  });

  it("toasts a thrown fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Browse for a folder" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("network down"));
  });

  it("saves a path and confirms agents can now propose changes", async () => {
    setPath.mockResolvedValue({ ok: true, codebase_path: "/repo/site" });
    renderCard();
    fireEvent.change(screen.getByLabelText("Local codebase folder"), {
      target: { value: "/repo/site" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(setPath).toHaveBeenCalledWith({
        project_slug: "acme",
        codebase_path: "/repo/site",
      });
      expect(toastSuccess).toHaveBeenCalledWith(
        "Codebase folder saved — agents can now propose code changes via pull requests.",
      );
    });
  });

  it("confirms clearing when the saved path comes back null", async () => {
    setPath.mockResolvedValue({ ok: true, codebase_path: null });
    renderCard("/repo/site");
    fireEvent.change(screen.getByLabelText("Local codebase folder"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Codebase folder cleared — agents can no longer change code.",
      ),
    );
  });

  it("surfaces a save error as a toast", async () => {
    setPath.mockResolvedValue({ ok: false, error: "bad path" });
    renderCard();
    fireEvent.change(screen.getByLabelText("Local codebase folder"), {
      target: { value: "/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("bad path"));
  });
});
