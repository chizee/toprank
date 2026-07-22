// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ filter: vi.fn() }));

vi.mock("@/lib/slash-commands", () => ({
  filterSlashCommands: mocks.filter,
}));
vi.mock("@/components/slash-command-popover", () => ({
  SlashCommandPopover: ({ commands, selectedIndex, onSelect, onHover }: {
    commands: Array<{ name: string; insert?: string }>;
    selectedIndex: number;
    onSelect: (command: { name: string; insert?: string }) => void;
    onHover: (index: number) => void;
  }) => (
    <div data-testid="slash" data-selected={selectedIndex}>
      {commands.map((command, index) => (
        <button key={command.name} onMouseEnter={() => onHover(index)} onClick={() => onSelect(command)}>
          {command.name}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@/components/running-dot", () => ({ RunningDot: () => <span data-testid="running-dot" /> }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({ children, value }: { children: React.ReactNode; value: string }) => <div data-testid="radio-group" data-value={value}>{children}</div>,
  DropdownMenuRadioItem: ({ children, value }: { children: React.ReactNode; value: string }) => <span data-testid="radio-item" data-value={value}>{children}</span>,
}));

import { ChatComposer } from "./composer";

const props = {
  busy: false,
  sendingChat: false,
  placeholder: "Message agent",
  model: "",
  reasoningEffort: "",
  onPickModel: vi.fn(),
  onPickReasoningEffort: vi.fn(),
  onSubmit: vi.fn(),
  onStop: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.filter.mockImplementation(() => [
    { name: "new" },
    { name: "clear", insert: "/clear" },
  ]);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => vi.unstubAllGlobals());

it("submits trimmed text by form submit and Enter, then clears", () => {
  render(<ChatComposer {...props} />);
  const textbox = screen.getByPlaceholderText("Message agent");
  Object.defineProperty(textbox, "scrollHeight", { configurable: true, value: 80 });
  fireEvent.change(textbox, { target: { value: "  hello  " } });
  expect(textbox).toHaveStyle({ height: "80px" });
  fireEvent.submit(textbox.closest("form")!);
  expect(props.onSubmit).toHaveBeenCalledWith("hello");
  expect(textbox).toHaveValue("");
  fireEvent.change(textbox, { target: { value: "again" } });
  fireEvent.keyDown(textbox, { key: "Enter", shiftKey: false });
  expect(props.onSubmit).toHaveBeenLastCalledWith("again");
});

it("allows Shift+Enter and blocks empty submissions", () => {
  render(<ChatComposer {...props} />);
  const textbox = screen.getByRole("textbox");
  fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
  fireEvent.submit(textbox.closest("form")!);
  expect(props.onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("shows model labels for selected, default, and stale values", () => {
  const options = [
    { value: "fast", label: "Fast", is_default: true },
    { value: "deep", label: "Deep" },
  ];
  const { rerender } = render(<ChatComposer {...props} modelOptions={options} model="deep" />);
  expect(screen.getByRole("button", { name: "Model and effort" })).toHaveTextContent("Deep");
  rerender(<ChatComposer {...props} modelOptions={options} model="missing" />);
  expect(screen.getByRole("button", { name: "Model and effort" })).toHaveTextContent("Fast");
  rerender(<ChatComposer {...props} modelOptions={[{ value: "x", label: "X" }]} model="" />);
  expect(screen.getByRole("button", { name: "Model and effort" })).toHaveTextContent("Default");
});

it("renders the provider default model once and exposes its dynamic effort choices", () => {
  const options = [
    {
      value: "fast",
      label: "Fast",
      is_default: true,
      default_reasoning_effort: "low",
      reasoning_efforts: [
        { value: "low", label: "Low", description: "Faster" },
        { value: "high", label: "High", description: "Deeper" },
      ],
    },
    { value: "deep", label: "Deep" },
  ];

  render(<ChatComposer {...props} modelOptions={options} />);

  expect(screen.queryByText("Fast (default)")).not.toBeInTheDocument();
  const items = screen.getAllByTestId("radio-item");
  expect(items.filter((item) => item.textContent === "Fast")).toHaveLength(1);
  expect(items.filter((item) => item.textContent === "Low")).toHaveLength(1);
  expect(items.filter((item) => item.textContent === "High")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Model and effort" })).toHaveTextContent(
    "Fast · Low",
  );
});

it("navigates slash matches with arrows and inserts via Tab", () => {
  render(<ChatComposer {...props} />);
  const textbox = screen.getByRole("textbox");
  fireEvent.change(textbox, { target: { value: "/" } });
  expect(screen.getByTestId("slash")).toHaveAttribute("data-selected", "0");
  fireEvent.keyDown(textbox, { key: "ArrowDown" });
  expect(screen.getByTestId("slash")).toHaveAttribute("data-selected", "1");
  fireEvent.keyDown(textbox, { key: "ArrowDown" });
  expect(screen.getByTestId("slash")).toHaveAttribute("data-selected", "0");
  fireEvent.keyDown(textbox, { key: "ArrowUp" });
  expect(screen.getByTestId("slash")).toHaveAttribute("data-selected", "1");
  fireEvent.keyDown(textbox, { key: "Tab" });
  expect(textbox).toHaveValue("/clear");
  expect(textbox).toHaveFocus();
});

it("inserts slash choices via click/Enter and dismisses with Escape", () => {
  render(<ChatComposer {...props} />);
  const textbox = screen.getByRole("textbox");
  fireEvent.change(textbox, { target: { value: "/" } });
  fireEvent.mouseEnter(screen.getByRole("button", { name: "clear" }));
  expect(screen.getByTestId("slash")).toHaveAttribute("data-selected", "1");
  fireEvent.click(screen.getByRole("button", { name: "new" }));
  expect(textbox).toHaveValue("/new ");
  fireEvent.change(textbox, { target: { value: "/" } });
  fireEvent.keyDown(textbox, { key: "Enter" });
  expect(textbox).toHaveValue("/new ");
  fireEvent.change(textbox, { target: { value: "/" } });
  fireEvent.keyDown(textbox, { key: "Escape" });
  expect(textbox).toHaveValue("");
});

it("hides slash choices after a space, while sending, or when disabled", () => {
  const { rerender } = render(<ChatComposer {...props} />);
  const textbox = screen.getByRole("textbox");
  fireEvent.change(textbox, { target: { value: "/new title" } });
  expect(screen.queryByTestId("slash")).not.toBeInTheDocument();
  rerender(<ChatComposer {...props} sendingChat busy />);
  expect(screen.queryByTestId("slash")).not.toBeInTheDocument();
  rerender(<ChatComposer {...props} disabled />);
  expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument();
});

it("renders local/remote busy copy and stops the turn", () => {
  const { rerender } = render(<ChatComposer {...props} busy sendingChat />);
  expect(screen.getByText(/Streaming/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(props.onStop).toHaveBeenCalled();
  rerender(<ChatComposer {...props} busy sendingChat={false} />);
  expect(screen.getByText(/Agent is working/)).toBeInTheDocument();
});
