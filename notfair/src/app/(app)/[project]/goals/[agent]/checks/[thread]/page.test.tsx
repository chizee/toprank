// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  resolveAgentBySlug: vi.fn(),
  getGoalForAgent: vi.fn(),
  getLatestGoalForAgent: vi.fn(),
  listGoalLearnings: vi.fn(),
  readTranscriptTail: vi.fn(),
  getMcpCatalog: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("@/server/db/projects", () => ({ getProject: mocks.getProject }));
vi.mock("@/server/agent-meta", () => ({ resolveAgentBySlug: mocks.resolveAgentBySlug }));
vi.mock("@/server/db/goals", () => ({
  getGoalForAgent: mocks.getGoalForAgent,
  getLatestGoalForAgent: mocks.getLatestGoalForAgent,
  listGoalLearnings: mocks.listGoalLearnings,
}));
vi.mock("@/server/sessions/transcript-tail", () => ({ readTranscriptTail: mocks.readTranscriptTail }));
vi.mock("@/server/mcp-catalog", () => ({ getMcpCatalog: mocks.getMcpCatalog }));
vi.mock("@/server/adapters/registry", () => ({
  DEFAULT_HARNESS_ADAPTER: "codex-local",
  requireAdapter: () => ({ listModels: mocks.listModels }),
}));
vi.mock("@/lib/project-href", () => ({ projectHref: (_slug: string, path: string) => path }));
vi.mock("@/lib/goal-label", () => ({ goalLabel: () => "Goal label" }));
vi.mock("@/components/goal-context-dialog", () => ({ GoalContextDialog: () => null }));
vi.mock("@/components/goal-memory-dialog", () => ({ GoalMemoryDialog: () => null }));
vi.mock("@/components/live-transcript", () => ({
  LiveTranscript: (props: Record<string, unknown>) => (
    <div
      data-testid="transcript"
      data-thread={String(props.threadId)}
      data-completed={String(props.showCompletedStatus)}
      data-models={String((props.modelOptions as unknown[]).length)}
    >
      <textarea
        aria-label="Tick chat composer"
        disabled={Boolean(props.composerDisabled)}
        placeholder={
          typeof props.disabledComposerPlaceholder === "string"
            ? props.disabledComposerPlaceholder
            : "Message this goal's agent…"
        }
      />
    </div>
  ),
}));

import CheckTranscriptPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockReturnValue({ archived_at: null, harness_adapter: "codex-local" });
  mocks.resolveAgentBySlug.mockResolvedValue({ agent_id: "agent-1", name: "Agent" });
  mocks.getGoalForAgent.mockReturnValue({ id: "goal-1" });
  mocks.getLatestGoalForAgent.mockReturnValue(null);
  mocks.listGoalLearnings.mockReturnValue([]);
  mocks.readTranscriptTail.mockReturnValue({ events: [], cursor: 17 });
  mocks.getMcpCatalog.mockReturnValue([]);
  mocks.listModels.mockResolvedValue([
    { value: "fast", label: "Fast", is_default: true },
    { value: "deep", label: "Deep" },
  ]);
});

// Regression: ISSUE-001 — completed tick transcripts disabled follow-up chat
// Found by /qa on 2026-07-21
// Report: .gstack/qa-reports/qa-report-localhost-2026-07-21.md
it("keeps a completed tick conversation chat-enabled with model selection", async () => {
  const page = await CheckTranscriptPage({
    params: Promise.resolve({ project: "acme", agent: "goal-1", thread: "tick-11" }),
  });
  render(page);

  expect(screen.getByRole("heading", { name: "Goal label — check chat" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Tick chat composer" })).toBeEnabled();
  expect(screen.getByPlaceholderText("Message this goal's agent…")).toBeInTheDocument();
  expect(screen.getByTestId("transcript")).toHaveAttribute("data-thread", "tick-11");
  expect(screen.getByTestId("transcript")).toHaveAttribute("data-completed", "true");
  expect(screen.getByTestId("transcript")).toHaveAttribute("data-models", "2");
});
