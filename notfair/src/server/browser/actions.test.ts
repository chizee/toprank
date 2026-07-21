// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  back,
  click,
  navigate,
  press,
  scroll,
  snapshot,
  type as typeText,
} from "./actions";

function locator() {
  return {
    click: vi.fn(async () => {}),
    dblclick: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
  };
}

function page() {
  const loc = locator();
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com/final"),
    title: vi.fn(async () => "Example"),
    locator: vi.fn(() => loc),
    keyboard: { press: vi.fn(async () => {}) },
    evaluate: vi.fn(async (fn: (arg: never) => unknown, arg: never) => fn(arg)),
    goBack: vi.fn(async () => null),
    loc,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 100, height: 20 }),
  });
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent ?? ""; },
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ visibility: "visible", display: "block" } as CSSStyleDeclaration);
});

afterEach(() => vi.restoreAllMocks());

it("navigates with defaults and tolerates a title failure", async () => {
  const p = page();
  await expect(navigate(p as never, { url: "https://example.com" })).resolves.toEqual({
    url: "https://example.com/final",
    title: "Example",
  });
  expect(p.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "load", timeout: 30_000 });
  p.title.mockRejectedValueOnce(new Error("gone"));
  await expect(navigate(p as never, { url: "x", waitUntil: "commit", timeoutMs: 5 })).resolves.toMatchObject({ title: "" });
});

it("snapshots visible interactive elements and replaces stale refs", async () => {
  document.title = "Snapshot";
  document.body.innerHTML = `
    <button data-notfair-ref="old" aria-label="Save" disabled>Ignored text</button>
    <span id="labelled">Account name</span><input id="account" aria-labelledby="labelled" value="123">
    <label for="email">Email address</label><input id="email" value="me@example.com">
    <input placeholder="Fallback placeholder" value="x">
    <a href="/next">Next page</a>
    <textarea>notes</textarea>
    <button id="hidden">Hidden</button>
  `;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => ({
    visibility: el.id === "hidden" ? "hidden" : "visible",
    display: "block",
  }) as CSSStyleDeclaration);
  const p = page();
  const result = await snapshot(p as never);
  expect(result.title).toBe("Snapshot");
  expect(result.elements).toEqual(expect.arrayContaining([
    expect.objectContaining({ ref: "e1", role: "button", name: "Save", disabled: true }),
    expect.objectContaining({ name: "Account name", value: "123" }),
    expect.objectContaining({ name: "Email address", value: "me@example.com" }),
    expect.objectContaining({ name: "Fallback placeholder" }),
    expect.objectContaining({ role: "a", href: expect.stringContaining("/next") }),
  ]));
  expect(document.querySelector("[data-notfair-ref=old]")).toBeNull();
  expect(document.querySelector("#hidden")?.hasAttribute("data-notfair-ref")).toBe(false);
});

it("filters zero-size and display-none elements", async () => {
  document.body.innerHTML = `<button id="zero">Zero</button><button id="none">None</button>`;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => ({
    visibility: "visible",
    display: el.id === "none" ? "none" : "block",
  }) as CSSStyleDeclaration);
  vi.spyOn(document.querySelector("#zero")!, "getBoundingClientRect").mockReturnValue({ width: 0, height: 10 } as DOMRect);
  const result = await snapshot(page() as never);
  expect(result.elements).toEqual([]);
});

it("clicks and double-clicks refs with options", async () => {
  let p = page();
  await click(p as never, { ref: "e2", button: "right", modifiers: ["Meta"], timeoutMs: 50 });
  expect(p.locator).toHaveBeenCalledWith('[data-notfair-ref="e2"]');
  expect(p.loc.click).toHaveBeenCalledWith({ button: "right", modifiers: ["Meta"], timeout: 50 });
  p = page();
  await click(p as never, { ref: "e1", doubleClick: true });
  expect(p.loc.dblclick).toHaveBeenCalledWith({ button: undefined, modifiers: undefined, timeout: 10_000 });
  await expect(click(p as never, { ref: "bad" })).rejects.toThrow(/Invalid ref/);
});

it("clears, types, and optionally submits", async () => {
  let p = page();
  await typeText(p as never, { ref: "e3", text: "hello", submit: true });
  expect(p.loc.fill).toHaveBeenNthCalledWith(1, "", { timeout: 10_000 });
  expect(p.loc.fill).toHaveBeenNthCalledWith(2, "hello", { timeout: 10_000 });
  expect(p.loc.press).toHaveBeenCalledWith("Enter", { timeout: 10_000 });
  p = page();
  await typeText(p as never, { ref: "e1", text: "append", clearFirst: false, timeoutMs: 1 });
  expect(p.loc.fill).toHaveBeenCalledTimes(1);
});

it("presses on a ref or at page level", async () => {
  const p = page();
  await press(p as never, { key: "Tab", ref: "e1", timeoutMs: 9 });
  expect(p.loc.press).toHaveBeenCalledWith("Tab", { timeout: 9 });
  await press(p as never, { key: "Escape" });
  expect(p.keyboard.press).toHaveBeenCalledWith("Escape");
});

it.each([
  ["left", 25, { x: -25, y: 0 }],
  ["right", 25, { x: 25, y: 0 }],
  ["up", 25, { x: 0, y: -25 }],
  ["down", undefined, { x: 0, y: 600 }],
])("scrolls %s", async (direction, amount, expected) => {
  const p = page();
  await scroll(p as never, { direction: direction as never, amount });
  expect(p.evaluate).toHaveBeenCalledWith(expect.any(Function), expected);
});

it("goes back and ignores navigation failures", async () => {
  const p = page();
  await back(p as never);
  expect(p.goBack).toHaveBeenCalledWith({ waitUntil: "load" });
  p.goBack.mockRejectedValueOnce(new Error("no history"));
  await expect(back(p as never)).resolves.toBeUndefined();
});
