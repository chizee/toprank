// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { GlobalLivenessPoller } from "./global-liveness-poller";

// Fake fetch backed by a queue of payloads. The poller hashes the
// response and only calls router.refresh() when the hash changes — so
// these tests are about the queue → refresh-count mapping.
type Payload = { project: string | null; agents: Record<string, number>; approvals: number };
let payloadQueue: Payload[] = [];
const fetchMock = vi.fn(async () => {
  const next = payloadQueue.shift() ?? STABLE_PAYLOAD;
  return new Response(JSON.stringify(next), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

const STABLE_PAYLOAD: Payload = {
  project: "acme",
  agents: { "acme-cmo-greg": 1 },
  approvals: 0,
};

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockClear();
  payloadQueue = [];
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Flush in-flight microtasks (the async fetch + await chain) inside the
// fake-timer regime so the signature-tracking effect runs before we
// assert.
async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GlobalLivenessPoller", () => {
  it("renders nothing in the DOM", () => {
    const { container } = render(<GlobalLivenessPoller hasInFlight={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("does not poll when hasInFlight is false", async () => {
    render(<GlobalLivenessPoller hasInFlight={false} />);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("polls every 2 s but does NOT call router.refresh when signature is unchanged", async () => {
    payloadQueue = [STABLE_PAYLOAD, STABLE_PAYLOAD, STABLE_PAYLOAD];
    render(<GlobalLivenessPoller hasInFlight={true} />);
    await flushAsync(); // initial seed fetch
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushAsync();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushAsync();
    // 1 seed + 2 ticks = 3 fetches. No refresh because signature is stable.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("calls router.refresh exactly when the signature changes", async () => {
    payloadQueue = [
      STABLE_PAYLOAD, // seed
      { ...STABLE_PAYLOAD, agents: { "acme-cmo-greg": 2 } }, // first tick — change!
      { ...STABLE_PAYLOAD, agents: { "acme-cmo-greg": 2 } }, // second tick — same as first
      { ...STABLE_PAYLOAD, agents: { "acme-cmo-greg": 0 } }, // third tick — change!
    ];
    render(<GlobalLivenessPoller hasInFlight={true} />);
    await flushAsync();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushAsync();
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushAsync();
    expect(refresh).toHaveBeenCalledTimes(1); // unchanged tick — no refresh
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushAsync();
    expect(refresh).toHaveBeenCalledTimes(2); // change again — refresh
  });

  it("tears the interval down when hasInFlight flips to false", async () => {
    payloadQueue = [STABLE_PAYLOAD, { ...STABLE_PAYLOAD, approvals: 1 }];
    const { rerender } = render(<GlobalLivenessPoller hasInFlight={true} />);
    await flushAsync();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushAsync();
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(<GlobalLivenessPoller hasInFlight={false} />);
    fetchMock.mockClear();
    refresh.mockClear();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clears the interval on unmount so no stray refreshes fire", async () => {
    payloadQueue = [STABLE_PAYLOAD];
    const { unmount } = render(<GlobalLivenessPoller hasInFlight={true} />);
    await flushAsync();
    unmount();
    fetchMock.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts a fresh interval if hasInFlight flips back to true after being false", async () => {
    const { rerender } = render(<GlobalLivenessPoller hasInFlight={false} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    await flushAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    payloadQueue = [STABLE_PAYLOAD, { ...STABLE_PAYLOAD, approvals: 5 }];
    rerender(<GlobalLivenessPoller hasInFlight={true} />);
    await flushAsync();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await flushAsync();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
