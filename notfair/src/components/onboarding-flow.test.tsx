// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  params: new Map<string, string>(),
  createProject: vi.fn(),
  getCards: vi.fn(),
  toastError: vi.fn(),
  mcpCardProps: [] as Array<Record<string, unknown>>,
  goalFormProps: vi.fn(),
  menuProps: vi.fn(),
  bannerProps: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => ({ get: (key: string) => mocks.params.get(key) ?? null }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/server/actions/projects", () => ({
  createProjectForOnboardingAction: mocks.createProject,
}));
vi.mock("@/server/onboarding/accounts", () => ({
  getOnboardingConnectCardsAction: mocks.getCards,
}));
vi.mock("@/components/mcp-flash-banner", () => ({
  McpFlashBanner: (props: Record<string, unknown>) => {
    mocks.bannerProps(props);
    return <div data-testid="flash-banner" />;
  },
}));
vi.mock("@/components/add-mcp-server-card", () => ({
  AddMcpServerMenu: (props: { trigger: React.ReactNode; connectedKeys: string[] }) => {
    mocks.menuProps(props);
    return <div data-testid="mcp-menu">{props.trigger}</div>;
  },
}));
vi.mock("@/components/mcp-card", () => ({
  McpCard: (props: Record<string, unknown> & { spec: { key: string }; onMutated: () => void }) => {
    mocks.mcpCardProps.push(props);
    return <button onClick={props.onMutated}>card:{props.spec.key}</button>;
  },
}));
vi.mock("@/components/new-goal-form", () => ({
  NewGoalForm: (props: Record<string, unknown>) => {
    mocks.goalFormProps(props);
    return <div data-testid="new-goal-form" />;
  },
}));

import { OnboardingFlow } from "./onboarding-flow";

const cards = [
  {
    spec: { key: "notfair-googleads", name: "Google Ads" },
    status: { state: "connected" },
    selected_id: "123",
  },
  {
    spec: { key: "notfair-metaads", name: "Meta Ads" },
    status: { state: "not_configured" },
    selected_id: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params.clear();
  mocks.mcpCardProps.length = 0;
  mocks.getCards.mockResolvedValue({ ok: true, cards, any_connected: true });
  mocks.createProject.mockResolvedValue({ ok: true, data: { slug: "acme", display_name: "Acme" } });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe("workspace step", () => {
  it("renders defaults, edits fields, and switches harnesses", () => {
    render(<OnboardingFlow />);
    expect(screen.getByRole("heading", { name: /set up your workspace/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(/Website URL/), { target: { value: "https://acme.test" } });
    expect(screen.getByRole("button", { name: /^Codex/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    expect(screen.getByRole("button", { name: /^Claude Code/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('input[name="harness_adapter"]')).toHaveValue("claude-code-local");
    expect(mocks.bannerProps).toHaveBeenCalledWith(expect.objectContaining({ analyzing: false }));
  });

  it("fills a picked codebase folder", async () => {
    vi.mocked(fetch).mockResolvedValue({ json: async () => ({ ok: true, path: "/repo/acme" }) } as never);
    render(<OnboardingFlow />);
    fireEvent.click(screen.getByRole("button", { name: "Browse for a folder" }));
    await waitFor(() => expect(screen.getByLabelText("Local codebase folder")).toHaveValue("/repo/acme"));
    fireEvent.change(screen.getByLabelText("Local codebase folder"), { target: { value: "/other" } });
    expect(screen.getByLabelText("Local codebase folder")).toHaveValue("/other");
  });

  it("silently handles cancellation and toasts picker failures", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ json: async () => ({ ok: false, kind: "cancelled" }) } as never)
      .mockResolvedValueOnce({ json: async () => ({ ok: false, kind: "unsupported" }) } as never)
      .mockRejectedValueOnce("network down");
    render(<OnboardingFlow />);
    const browse = screen.getByRole("button", { name: "Browse for a folder" });
    fireEvent.click(browse);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).not.toHaveBeenCalled();
    fireEvent.click(browse);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Couldn't open the folder picker."));
    fireEvent.click(browse);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("network down"));
  });
});

describe("connect step", () => {
  beforeEach(() => {
    mocks.params.set("step", "connect");
    mocks.params.set("slug", "acme co");
    mocks.params.set("mcp_connected", "google");
    mocks.params.set("mcp_analyzing", "1");
  });

  it("shows loading, then cards, passes picker state, and advances", async () => {
    let resolve!: (value: unknown) => void;
    mocks.getCards.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(
      <OnboardingFlow
        pickerMcpKey="notfair-googleads"
        pickerPrefetch={{ ok: true, items: [], selected_id: "123" } as never}
      />,
    );
    expect(screen.getByText(/Loading your connections/)).toBeInTheDocument();
    resolve({ ok: true, cards, any_connected: true });
    await screen.findByRole("heading", { name: /Connect your data sources/i });
    expect(screen.getByText("card:notfair-googleads")).toBeInTheDocument();
    expect(mocks.mcpCardProps[0]).toMatchObject({
      projectSlug: "acme co",
      selectedAccountId: "123",
      pickerPrefetch: { ok: true, items: [], selected_id: "123" },
    });
    expect(mocks.mcpCardProps[1]?.pickerPrefetch).toBeNull();
    expect(mocks.menuProps).toHaveBeenCalledWith(expect.objectContaining({ connectedKeys: ["notfair-googleads"] }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(mocks.push).toHaveBeenCalledWith("/onboarding?step=goal&slug=acme%20co");
  });

  it("reloads card state after a card mutation", async () => {
    render(<OnboardingFlow />);
    await screen.findByText("card:notfair-googleads");
    fireEvent.click(screen.getByText("card:notfair-googleads"));
    await waitFor(() => expect(mocks.getCards).toHaveBeenCalledTimes(2));
  });

  it("shows load errors", async () => {
    mocks.getCards.mockResolvedValue({ ok: false, error: "MCP unavailable" });
    render(<OnboardingFlow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("MCP unavailable");
    expect(screen.getByRole("link", { name: "Start over" })).toHaveAttribute("href", "/onboarding");
  });

  it("skips directly into the workspace when nothing is connected", async () => {
    mocks.getCards.mockResolvedValue({ ok: true, cards: [], any_connected: false });
    render(<OnboardingFlow />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    expect(mocks.replace).toHaveBeenCalledWith("/acme co");
  });
});

it("renders the first-goal step and forwards connected keys", () => {
  mocks.params.set("step", "goal");
  mocks.params.set("slug", "acme");
  render(<OnboardingFlow connectedMcpKeys={["google", "meta"]} />);
  expect(screen.getByRole("heading", { name: /Create your first goal/ })).toBeInTheDocument();
  expect(mocks.goalFormProps).toHaveBeenCalledWith({ projectSlug: "acme", connectedMcpKeys: ["google", "meta"] });
  expect(screen.getByRole("link", { name: "Skip for now" })).toHaveAttribute("href", "/acme");
});

it("renders a recovery path when a later step has no slug", () => {
  mocks.params.set("step", "goal");
  render(<OnboardingFlow />);
  expect(screen.getByText(/This step needs a workspace/)).toBeInTheDocument();
});
