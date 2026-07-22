// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AddMcpServerMenu } from "@/components/add-mcp-server-card";

// Mock at the server-action boundary, per repo test conventions.
const addServer = vi.hoisted(() => vi.fn());
const startConnect = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/mcp", () => ({
  addUserMcpServerAction: addServer,
  startMcpConnect: startConnect,
}));

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function openBrowser() {
  fireEvent.click(screen.getByRole("button", { name: /add server/i }));
}

describe("AddMcpServerMenu", () => {
  it("opens Browse connectors directly from the default trigger", () => {
    render(<AddMcpServerMenu />);
    openBrowser();
    expect(
      screen.getByRole("heading", { name: "Browse connectors" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add custom connector/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens Browse connectors directly from a custom trigger", () => {
    render(
      <AddMcpServerMenu
        trigger={<button type="button">More tools</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "More tools" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add server/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    expect(
      screen.getByRole("heading", { name: "Browse connectors" }),
    ).toBeInTheDocument();
  });

  it("adds a custom OAuth connector and refreshes on success", async () => {
    addServer.mockResolvedValue({ ok: true, key: "stripe" });
    render(<AddMcpServerMenu />);
    openBrowser();
    fireEvent.click(screen.getByRole("button", { name: /add custom connector/i }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Stripe" },
    });
    fireEvent.change(screen.getByLabelText("Remote MCP server URL"), {
      target: { value: "https://mcp.stripe.com/" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /^add server$/i }));

    await waitFor(() => {
      expect(addServer).toHaveBeenCalledWith({
        display_name: "Stripe",
        resource_url: "https://mcp.stripe.com/",
      });
      expect(toastSuccess).toHaveBeenCalledWith(
        "Added MCP server 'stripe'. Click Connect to authorize.",
      );
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("shows the probe failure inline and keeps the dialog open", async () => {
    addServer.mockResolvedValue({ ok: false, error: "No OAuth discovery." });
    render(<AddMcpServerMenu />);
    openBrowser();
    fireEvent.click(screen.getByRole("button", { name: /add custom connector/i }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Broken" },
    });
    fireEvent.change(screen.getByLabelText("Remote MCP server URL"), {
      target: { value: "https://broken.example.com/" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /^add server$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No OAuth discovery.",
    );
    // Dialog stays open for a retry — the name field is still there.
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
