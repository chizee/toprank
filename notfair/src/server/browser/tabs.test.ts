import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getOrLaunchBrowser: vi.fn() }));
vi.mock("./session", () => ({ getOrLaunchBrowser: mocks.getOrLaunchBrowser }));

import {
  _resetTabRegistries,
  assertValidLabel,
  closeTab,
  getTab,
  listTabs,
  openTab,
} from "./tabs";

function fakePage(url = "about:blank", title = "Blank") {
  const events = new EventEmitter();
  let closed = false;
  return {
    url: vi.fn(() => url),
    title: vi.fn(async () => title),
    goto: vi.fn(async () => {}),
    isClosed: vi.fn(() => closed),
    close: vi.fn(async () => { closed = true; events.emit("close"); }),
    once: events.once.bind(events),
    emitClose: () => events.emit("close"),
    setClosed: (value: boolean) => { closed = value; },
  };
}

function fakeSession(initialPages: ReturnType<typeof fakePage>[] = []) {
  const events = new EventEmitter();
  const pages = [...initialPages];
  return {
    context: {
      pages: vi.fn(() => pages),
      newPage: vi.fn(async () => {
        const p = fakePage();
        pages.push(p);
        return p;
      }),
      on: events.on.bind(events),
    },
    pages,
    closeContext: () => events.emit("close"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetTabRegistries();
  mocks.getOrLaunchBrowser.mockResolvedValue(fakeSession() as never);
});

it("validates labels at both boundaries", () => {
  for (const valid of ["a", "Goal_1", "tab-2", "a".repeat(64)]) {
    expect(() => assertValidLabel(valid)).not.toThrow();
  }
  for (const invalid of ["", "-bad", "has space", "a".repeat(65)]) {
    expect(() => assertValidLabel(invalid)).toThrow(/Invalid tab label/);
  }
});

it("adopts initial pages and opens auto-numbered tabs", async () => {
  const initial = fakePage("https://initial", "Initial");
  const session = fakeSession([initial]);
  mocks.getOrLaunchBrowser.mockResolvedValue(session as never);
  expect(await getTab("acme", "t1")).toBe(initial);
  const opened = await openTab("acme");
  expect(opened).toMatchObject({ id: "t2", label: "t2", url: "about:blank" });
  expect(session.context.newPage).toHaveBeenCalled();
});

it("opens and reuses a labeled tab with navigation options", async () => {
  const session = fakeSession();
  mocks.getOrLaunchBrowser.mockResolvedValue(session as never);
  const first = await openTab("acme", {
    label: "reports",
    url: "https://example.com",
    waitUntil: "networkidle",
    timeoutMs: 55,
  });
  const created = session.pages[0]!;
  expect(first.id).toBe("reports");
  expect(created.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "networkidle", timeout: 55 });
  await openTab("acme", { label: "reports", url: "https://next" });
  expect(session.context.newPage).toHaveBeenCalledTimes(1);
  expect(created.goto).toHaveBeenLastCalledWith("https://next", { waitUntil: "load", timeout: 30_000 });
  await expect(openTab("acme", { label: " bad" })).rejects.toThrow(/Invalid tab label/);
});

it("reconciles external pages and returns fresh titles", async () => {
  const known = fakePage("https://known", "Known");
  const session = fakeSession([known]);
  mocks.getOrLaunchBrowser.mockResolvedValue(session as never);
  await listTabs("acme");
  const external = fakePage("https://external", "External");
  session.pages.push(external);
  const handles = await listTabs("acme");
  expect(handles).toEqual([
    { id: "t1", label: "t1", url: "https://known", title: "Known" },
    { id: "t2", label: "t2", url: "https://external", title: "External" },
  ]);
});

it("drops closed pages and falls back when URL/title access throws", async () => {
  const closed = fakePage();
  closed.setClosed(true);
  const broken = fakePage();
  broken.url.mockImplementation(() => { throw new Error("detached"); });
  broken.title.mockRejectedValue(new Error("detached"));
  const session = fakeSession([closed, broken]);
  mocks.getOrLaunchBrowser.mockResolvedValue(session as never);
  await expect(listTabs("acme")).resolves.toEqual([
    { id: "t2", label: "t2", url: "", title: "" },
  ]);
});

it("returns false for missing tabs and closes live tabs", async () => {
  const session = fakeSession();
  mocks.getOrLaunchBrowser.mockResolvedValue(session as never);
  await expect(closeTab("acme", "missing")).resolves.toBe(false);
  await openTab("acme", { label: "one" });
  await expect(closeTab("acme", "one")).resolves.toBe(true);
  expect(session.pages[0]!.close).toHaveBeenCalled();
  await expect(getTab("acme", "one")).resolves.toBeNull();
});

it("tolerates close failures and cleans up event-driven closures", async () => {
  const p = fakePage();
  p.close.mockRejectedValue(new Error("already gone"));
  const session = fakeSession([p]);
  mocks.getOrLaunchBrowser.mockResolvedValue(session as never);
  await expect(closeTab("acme", "t1")).resolves.toBe(true);

  _resetTabRegistries();
  p.close.mockResolvedValue(undefined);
  p.setClosed(false);
  await getTab("acme", "t1");
  p.emitClose();
  await expect(getTab("acme", "t1")).resolves.toBeNull();
});

it("rebuilds the registry when the browser session changes and clears on context close", async () => {
  const first = fakeSession([fakePage("first")]);
  const second = fakeSession([fakePage("second")]);
  mocks.getOrLaunchBrowser.mockResolvedValueOnce(first as never).mockResolvedValue(second as never);
  expect(await getTab("acme", "t1")).toBe(first.pages[0]);
  expect(await getTab("acme", "t1")).toBe(second.pages[0]);
  second.closeContext();
  expect(await getTab("acme", "t1")).toBeNull();
});
