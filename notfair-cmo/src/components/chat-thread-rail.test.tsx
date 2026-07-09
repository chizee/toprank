// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/server/actions/chat-threads", () => ({
  renameThreadAction: vi.fn(async () => ({ ok: true })),
  setThreadPinnedAction: vi.fn(async () => ({ ok: true })),
  deleteThreadAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ChatThreadRail, type SessionLite } from "./chat-thread-rail";

function makeSession(overrides: Partial<SessionLite> = {}): SessionLite {
  return {
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    label: "aaaa1111",
    sessionKey: "aaaa1111",
    lastInteractionAt: Date.now(),
    pending: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("ChatThreadRail", () => {
  it("renders the New chat button on top, text-only rows, and hides task threads", () => {
    render(
      <ChatThreadRail
        projectSlug="demo"
        agentSlug="cmo-greg"
        activeSessionId="aaaa1111-0000-0000-0000-000000000000"
        sessions={[
          makeSession({
            origin: { kind: "chat", preview: "What should we launch first?" },
          }),
          // Task-kickoff threads live on the Tasks tab — not here.
          makeSession({
            sessionId: "bbbb2222-0000-0000-0000-000000000000",
            label: "bbbb2222",
            sessionKey: "bbbb2222",
            origin: { kind: "task", display_id: "demo-1", title: "Audit the account" },
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /New chat/i })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("What should we launch first?")).toBeInTheDocument();
    expect(screen.queryByText(/Audit the account/)).not.toBeInTheDocument();
    // Text only — no thread-id line on the rows.
    expect(screen.queryByText("aaaa1111")).not.toBeInTheDocument();
  });

  it("links each row to its thread and marks the active one", () => {
    render(
      <ChatThreadRail
        projectSlug="demo"
        agentSlug="cmo-greg"
        activeSessionId="aaaa1111-0000-0000-0000-000000000000"
        sessions={[
          makeSession({ origin: { kind: "chat", preview: "alpha" } }),
          makeSession({
            sessionId: "bbbb2222-0000-0000-0000-000000000000",
            label: "bbbb2222",
            sessionKey: "bbbb2222",
            origin: { kind: "chat", preview: "beta" },
          }),
        ]}
      />,
    );
    const active = screen.getByText("alpha").closest("a");
    const other = screen.getByText("beta").closest("a");
    expect(active).toHaveAttribute(
      "href",
      "/demo/agents/cmo-greg/chat/aaaa1111-0000-0000-0000-000000000000",
    );
    expect(active).toHaveAttribute("aria-current", "true");
    expect(other).not.toHaveAttribute("aria-current");
  });

  it("prefers the user-set title and marks pinned threads", () => {
    render(
      <ChatThreadRail
        projectSlug="demo"
        agentSlug="cmo-greg"
        activeSessionId="x"
        sessions={[
          makeSession({
            title: "Q4 planning",
            pinned: true,
            origin: { kind: "chat", preview: "ignored preview" },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Q4 planning")).toBeInTheDocument();
    expect(screen.queryByText("ignored preview")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  });

  it("opens the ⋮ menu with Rename / Pin / Delete", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <ChatThreadRail
        projectSlug="demo"
        agentSlug="cmo-greg"
        activeSessionId="x"
        sessions={[makeSession({ origin: { kind: "chat", preview: "alpha" } })]}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Thread actions for alpha/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    expect(await screen.findByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Pin")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    // Delete routes through an explicit confirm dialog.
    fireEvent.click(screen.getByText("Delete"));
    expect(await screen.findByText("Delete thread?")).toBeInTheDocument();
  });

  it("labels pending threads as new and shows the empty state without threads", () => {
    const { unmount } = render(
      <ChatThreadRail
        projectSlug="demo"
        agentSlug="cmo-greg"
        activeSessionId="cccc3333-0000-0000-0000-000000000000"
        sessions={[
          makeSession({
            sessionId: "cccc3333-0000-0000-0000-000000000000",
            pending: true,
          }),
        ]}
      />,
    );
    expect(screen.getByText("New thread")).toBeInTheDocument();
    unmount();

    render(
      <ChatThreadRail
        projectSlug="demo"
        agentSlug="cmo-greg"
        activeSessionId="x"
        sessions={[]}
      />,
    );
    expect(screen.getByText(/No threads yet/)).toBeInTheDocument();
  });
});
