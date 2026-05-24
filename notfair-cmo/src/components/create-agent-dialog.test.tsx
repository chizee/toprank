// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const router = {
  push: vi.fn(),
  refresh: vi.fn(),
};

const listOpenClawAgentsAction = vi.fn();
const listProjectAgentsAction = vi.fn();
const createAgentAction = vi.fn();
const cloneAgentAction = vi.fn();

const toast = {
  success: vi.fn(),
  error: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("@/server/actions/agents", () => ({
  listOpenClawAgentsAction: (...args: unknown[]) =>
    listOpenClawAgentsAction(...args),
  listProjectAgentsAction: (...args: unknown[]) =>
    listProjectAgentsAction(...args),
  createAgentAction: (...args: unknown[]) => createAgentAction(...args),
  cloneAgentAction: (...args: unknown[]) => cloneAgentAction(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toast.success(...args),
    error: (...args: unknown[]) => toast.error(...args),
  },
}));

vi.mock("./disable-source-crons-dialog", () => ({
  DisableSourceCronsDialog: ({
    sourceLabel,
    sourceCrons,
    onDone,
  }: {
    sourceLabel: string;
    sourceCrons: Array<{ id: string }>;
    onDone: () => void;
  }) => (
    <div data-testid="disable-source-crons-dialog">
      from {sourceLabel} with {sourceCrons.length} crons
      <button onClick={onDone}>finish</button>
    </div>
  ),
}));

import { CreateAgentDialog } from "./create-agent-dialog";

const choices = [
  {
    agent_id: "other-cmo",
    display_name: "Other CMO",
    in_current_project: false,
  },
  {
    agent_id: "proj-existing",
    display_name: "Existing",
    in_current_project: true,
  },
];

const projectAgents = [
  { agent_id: "proj-existing", slug: "existing", display_name: "Existing" },
];

beforeEach(() => {
  router.push.mockReset();
  router.refresh.mockReset();
  listOpenClawAgentsAction.mockReset();
  listProjectAgentsAction.mockReset();
  createAgentAction.mockReset();
  cloneAgentAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  listOpenClawAgentsAction.mockResolvedValue({ ok: true, data: choices });
  listProjectAgentsAction.mockResolvedValue({ ok: true, data: projectAgents });
});

afterEach(() => {
  cleanup();
});

describe("CreateAgentDialog — create mode", () => {
  it("renders nothing visible when closed", () => {
    const onOpenChange = vi.fn();
    render(
      <CreateAgentDialog open={false} onOpenChange={onOpenChange} projectSlug="proj" />,
    );
    expect(screen.queryByText("New agent")).not.toBeInTheDocument();
  });

  it("renders create-mode UI with the project prefix when open", () => {
    render(
      <CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />,
    );
    expect(screen.getByText("New agent")).toBeInTheDocument();
    expect(screen.getByText("proj-")).toBeInTheDocument();
    expect(screen.getByLabelText(/Agent name/i)).toBeInTheDocument();
  });

  it("disables Create when the name is empty", () => {
    render(<CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />);
    expect(
      screen.getByRole("button", { name: /create agent/i }),
    ).toBeDisabled();
  });

  it("flags an in-project name collision and disables Create", async () => {
    render(<CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />);
    await waitFor(() => expect(listProjectAgentsAction).toHaveBeenCalled());
    const input = screen.getByLabelText(/Agent name/i);
    fireEvent.change(input, { target: { value: "existing" } });
    await waitFor(() =>
      expect(
        screen.getByText(/already exists in this project/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /create agent/i }),
    ).toBeDisabled();
  });

  it("flags an invalid (reserved) name", async () => {
    render(<CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />);
    const input = screen.getByLabelText(/Agent name/i);
    fireEvent.change(input, { target: { value: "settings" } });
    await waitFor(() =>
      expect(screen.getByText(/invalid name/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /create agent/i }),
    ).toBeDisabled();
  });

  it("calls createAgentAction on submit and routes to the new agent", async () => {
    createAgentAction.mockResolvedValue({
      ok: true,
      data: { slug: "new-agent" },
    });
    const onOpenChange = vi.fn();
    render(
      <CreateAgentDialog open onOpenChange={onOpenChange} projectSlug="proj" />,
    );
    await waitFor(() => expect(listProjectAgentsAction).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Agent name/i), {
      target: { value: "new-agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() =>
      expect(createAgentAction).toHaveBeenCalledWith({
        display_name: "new-agent",
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/proj/agents/new-agent/chat"),
    );
  });

  it("toasts the server error when create fails", async () => {
    createAgentAction.mockResolvedValue({ ok: false, error: "denied" });
    render(<CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />);
    await waitFor(() => expect(listProjectAgentsAction).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Agent name/i), {
      target: { value: "new-agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("denied"));
  });

  it("closes when Cancel is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <CreateAgentDialog open onOpenChange={onOpenChange} projectSlug="proj" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CreateAgentDialog — clone mode", () => {
  function openInCloneMode() {
    render(<CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />);
    fireEvent.click(screen.getByRole("button", { name: /clone existing/i }));
  }

  it("shows the source picker once choices have loaded", async () => {
    openInCloneMode();
    await waitFor(() => expect(listOpenClawAgentsAction).toHaveBeenCalled());
    expect(await screen.findByLabelText(/source agent/i)).toBeInTheDocument();
  });

  it("renders a loading indicator while fetching the catalog", async () => {
    listOpenClawAgentsAction.mockImplementation(() => new Promise(() => {}));
    listProjectAgentsAction.mockImplementation(() => new Promise(() => {}));
    openInCloneMode();
    expect(await screen.findByText(/loading agents/i)).toBeInTheDocument();
  });

  it("renders the error message when the catalog fails to load", async () => {
    listOpenClawAgentsAction.mockResolvedValue({ ok: false, error: "boom" });
    openInCloneMode();
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("disables Clone when source not picked or name is empty", async () => {
    openInCloneMode();
    await waitFor(() => expect(listOpenClawAgentsAction).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: /clone agent/i }),
    ).toBeDisabled();
  });

  it("invokes cloneAgentAction with the chosen source and name", async () => {
    cloneAgentAction.mockResolvedValue({
      ok: true,
      data: { new_slug: "clone-x", new_agent_id: "proj-clone-x", source_crons: [] },
    });
    const onOpenChange = vi.fn();
    render(<CreateAgentDialog open onOpenChange={onOpenChange} projectSlug="proj" />);
    fireEvent.click(screen.getByRole("button", { name: /clone existing/i }));
    await waitFor(() => expect(listOpenClawAgentsAction).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText(/source agent/i), {
      target: { value: "other-cmo" },
    });
    fireEvent.change(screen.getByLabelText(/new agent name/i), {
      target: { value: "clone-x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /clone agent/i }));
    await waitFor(() =>
      expect(cloneAgentAction).toHaveBeenCalledWith({
        source_agent_id: "other-cmo",
        new_display_name: "clone-x",
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/proj/agents/clone-x/chat"),
    );
  });

  it("opens the disable-crons follow-up dialog when the source had crons", async () => {
    cloneAgentAction.mockResolvedValue({
      ok: true,
      data: {
        new_slug: "clone-x",
        new_agent_id: "proj-clone-x",
        source_crons: [{ id: "c1" }, { id: "c2" }],
      },
    });
    render(<CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />);
    fireEvent.click(screen.getByRole("button", { name: /clone existing/i }));
    await waitFor(() => expect(listOpenClawAgentsAction).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText(/source agent/i), {
      target: { value: "other-cmo" },
    });
    fireEvent.change(screen.getByLabelText(/new agent name/i), {
      target: { value: "clone-x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /clone agent/i }));
    const followUp = await screen.findByTestId("disable-source-crons-dialog");
    expect(followUp).toBeInTheDocument();
    expect(followUp.textContent).toMatch(/Other CMO/i);
    expect(followUp.textContent).toMatch(/2 crons/i);
  });

  it("toasts a server error when clone fails", async () => {
    cloneAgentAction.mockResolvedValue({ ok: false, error: "no space" });
    render(<CreateAgentDialog open onOpenChange={vi.fn()} projectSlug="proj" />);
    fireEvent.click(screen.getByRole("button", { name: /clone existing/i }));
    await waitFor(() => expect(listOpenClawAgentsAction).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText(/source agent/i), {
      target: { value: "other-cmo" },
    });
    fireEvent.change(screen.getByLabelText(/new agent name/i), {
      target: { value: "clone-x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /clone agent/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("no space"));
  });
});
