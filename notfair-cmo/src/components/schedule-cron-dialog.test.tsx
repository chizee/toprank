// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

if (typeof Element !== "undefined") {
  // @ts-expect-error - jsdom shim
  Element.prototype.hasPointerCapture ??= () => false;
  // @ts-expect-error - jsdom shim
  Element.prototype.setPointerCapture ??= () => {};
  // @ts-expect-error - jsdom shim
  Element.prototype.releasePointerCapture ??= () => {};
  // @ts-expect-error - jsdom shim
  Element.prototype.scrollIntoView ??= () => {};
}

const scheduleCronAction = vi.fn();
const toast = {
  success: vi.fn(),
  error: vi.fn(),
};

vi.mock("@/server/actions/crons", () => ({
  scheduleCronAction: (...args: unknown[]) => scheduleCronAction(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toast.success(...args),
    error: (...args: unknown[]) => toast.error(...args),
  },
}));

import { ScheduleCronDialog } from "./schedule-cron-dialog";

function openDialog() {
  const trigger = screen.getAllByRole("button").find((b) => b.textContent?.includes("New cron"));
  if (!trigger) throw new Error("Trigger not found");
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
}

beforeEach(() => {
  scheduleCronAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => cleanup());

describe("ScheduleCronDialog", () => {
  it("renders the default 'button' trigger with 'New cron' label", () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    expect(screen.getByRole("button", { name: /new cron/i })).toBeInTheDocument();
  });

  it("renders an icon trigger with sr-only label when variant='icon'", () => {
    render(<ScheduleCronDialog projectSlug="acme" variant="icon" />);
    expect(screen.getByText(/schedule recurring work/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New cron" })).not.toBeInTheDocument();
  });

  it("opens the dialog when the trigger is clicked", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    await waitFor(() => {
      expect(screen.getByText("Schedule recurring work")).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Agent/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Brief/i)).toBeInTheDocument();
  });

  it("defaults the specialist to google_ads when no override is provided", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    const select = (await screen.findByLabelText(/Agent/i)) as HTMLSelectElement;
    expect(select.value).toBe("google_ads");
  });

  it("honors defaultSpecialist", async () => {
    render(<ScheduleCronDialog projectSlug="acme" defaultSpecialist="seo" />);
    openDialog();
    const select = (await screen.findByLabelText(/Agent/i)) as HTMLSelectElement;
    expect(select.value).toBe("seo");
  });

  it("starts with 'every 1h' schedule and no timezone input visible", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    const scheduleInput = (await screen.findByPlaceholderText("1h")) as HTMLInputElement;
    expect(scheduleInput.value).toBe("1h");
    expect(screen.queryByPlaceholderText(/Timezone/i)).not.toBeInTheDocument();
  });

  it("shows the timezone input when schedule kind switches to 'cron'", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    const kindSelect = (await screen.findByDisplayValue("Every")) as HTMLSelectElement;
    fireEvent.change(kindSelect, { target: { value: "cron" } });
    expect(screen.getByPlaceholderText(/Timezone/i)).toBeInTheDocument();
  });

  it("disables the Schedule button until name and brief are filled", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    const submit = await screen.findByRole("button", { name: /^schedule$/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "daily-opt" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Brief/i), { target: { value: "do the thing" } });
    expect(submit).not.toBeDisabled();
  });

  it("treats whitespace-only name and brief as empty (still disabled)", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText(/Brief/i), { target: { value: "   " } });
    const submit = await screen.findByRole("button", { name: /^schedule$/i });
    expect(submit).toBeDisabled();
  });

  it("submits with current 'every' values and toasts success on ok", async () => {
    scheduleCronAction.mockResolvedValue({ ok: true, cron_id: "c1", cron_name: "acme-google_ads-daily-opt" });
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    fireEvent.change(await screen.findByLabelText(/Name/i), { target: { value: "daily-opt" } });
    fireEvent.change(screen.getByLabelText(/Brief/i), { target: { value: "do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
    await waitFor(() =>
      expect(scheduleCronAction).toHaveBeenCalledWith({
        project_slug: "acme",
        specialist: "google_ads",
        name: "daily-opt",
        schedule_kind: "every",
        schedule_value: "1h",
        tz: undefined,
        brief: "do the thing",
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Scheduled acme-google_ads-daily-opt"),
    );
  });

  it("includes tz only when schedule_kind is 'cron'", async () => {
    scheduleCronAction.mockResolvedValue({ ok: true, cron_id: "c1", cron_name: "x" });
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    const kindSelect = (await screen.findByDisplayValue("Every")) as HTMLSelectElement;
    fireEvent.change(kindSelect, { target: { value: "cron" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "cron-job" } });
    fireEvent.change(screen.getByLabelText(/Brief/i), { target: { value: "tick" } });
    fireEvent.change(screen.getAllByDisplayValue("1h")[0]!, { target: { value: "0 9 * * *" } });
    fireEvent.change(screen.getByPlaceholderText(/Timezone/i), {
      target: { value: "America/New_York" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
    await waitFor(() =>
      expect(scheduleCronAction).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule_kind: "cron",
          schedule_value: "0 9 * * *",
          tz: "America/New_York",
        }),
      ),
    );
  });

  it("toasts the server error when the action returns ok=false and keeps the dialog open", async () => {
    scheduleCronAction.mockResolvedValue({ ok: false, error: "invalid cron" });
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    fireEvent.change(await screen.findByLabelText(/Name/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/Brief/i), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("invalid cron"));
    expect(toast.success).not.toHaveBeenCalled();
    // Dialog still visible
    expect(screen.getByText("Schedule recurring work")).toBeInTheDocument();
  });

  it("Cancel button closes the dialog without invoking the action", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(scheduleCronAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText("Schedule recurring work")).not.toBeInTheDocument(),
    );
  });

  it("preset menu items apply their schedule kind, value, and timezone", async () => {
    render(<ScheduleCronDialog projectSlug="acme" />);
    openDialog();
    const presetsBtn = await screen.findByRole("button", { name: /presets/i });
    fireEvent.pointerDown(presetsBtn, { button: 0 });
    fireEvent.click(presetsBtn);
    const preset = await screen.findByText("Daily at 9am (Los Angeles)");
    fireEvent.click(preset);
    // schedule kind select should now be "cron" (i.e. show "Cron expr")
    const kindSelect = screen.getByDisplayValue("Cron expr") as HTMLSelectElement;
    expect(kindSelect.value).toBe("cron");
    expect(screen.getByDisplayValue("0 9 * * *")).toBeInTheDocument();
    expect(screen.getByDisplayValue("America/Los_Angeles")).toBeInTheDocument();
  });
});
