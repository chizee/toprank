import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _clearProbeCacheForTests,
  getCachedProbe,
  invalidateProbe,
  setCachedProbe,
} from "./probe-cache";
import type { McpRuntimeStatus } from "./state";

const connected: McpRuntimeStatus = {
  state: "connected",
  url: "https://x",
  tools_count: null,
  last_checked_at: "now",
};
const unreachable: McpRuntimeStatus = {
  state: "unreachable",
  url: "https://x",
  error: "down",
  last_checked_at: "now",
};
const staleToken: McpRuntimeStatus = {
  state: "stale_token",
  url: "https://x",
  http_status: 401,
  last_checked_at: "now",
};

beforeEach(() => _clearProbeCacheForTests());
afterEach(() => {
  vi.useRealTimers();
  _clearProbeCacheForTests();
});

describe("probe-cache", () => {
  it("misses on an empty cache", () => {
    expect(getCachedProbe("p", "k")).toBeNull();
  });

  it("caches connected results and reads them back", () => {
    setCachedProbe("p", "k", connected);
    expect(getCachedProbe("p", "k")).toEqual(connected);
  });

  it("caches unreachable results", () => {
    setCachedProbe("p", "k", unreachable);
    expect(getCachedProbe("p", "k")).toEqual(unreachable);
  });

  it("does not cache stale_token (ttl 0) and clears a prior entry", () => {
    setCachedProbe("p", "k", connected);
    setCachedProbe("p", "k", staleToken);
    expect(getCachedProbe("p", "k")).toBeNull();
  });

  it("does not cache not_configured", () => {
    setCachedProbe("p", "k", { state: "not_configured" });
    expect(getCachedProbe("p", "k")).toBeNull();
  });

  it("keys entries by project + catalog", () => {
    setCachedProbe("p1", "k", connected);
    expect(getCachedProbe("p2", "k")).toBeNull();
    expect(getCachedProbe("p1", "k2")).toBeNull();
  });

  it("expires connected entries after 60s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setCachedProbe("p", "k", connected);
    vi.setSystemTime(59_999);
    expect(getCachedProbe("p", "k")).toEqual(connected);
    vi.setSystemTime(60_001);
    expect(getCachedProbe("p", "k")).toBeNull();
  });

  it("expires unreachable entries after 10s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setCachedProbe("p", "k", unreachable);
    vi.setSystemTime(10_001);
    expect(getCachedProbe("p", "k")).toBeNull();
  });

  it("invalidateProbe drops the entry", () => {
    setCachedProbe("p", "k", connected);
    invalidateProbe("p", "k");
    expect(getCachedProbe("p", "k")).toBeNull();
  });
});
