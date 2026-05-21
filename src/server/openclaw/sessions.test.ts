import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { tmpHome, ORIGINAL_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  const original = process.env.OPENCLAW_HOME;
  const tmp = mkdtempSync(joinPath(tmpdir(), "notfair-cmo-sessions-"));
  process.env.OPENCLAW_HOME = tmp;
  return { tmpHome: tmp, ORIGINAL_HOME: original };
});

// Mock next/headers cookies API. Each test sets the cookie state via the
// `cookieStore` helper below.
type CookieMap = Map<string, string>;
const cookieStore: CookieMap = new Map();
let setCalls: Array<{ name: string; value: string; opts: unknown }> = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = cookieStore.get(name);
      return v === undefined ? undefined : { value: v };
    },
    set: (name: string, value: string, opts: unknown) => {
      cookieStore.set(name, value);
      setCalls.push({ name, value, opts });
    },
  }),
}));

import {
  buildPendingSessionKey,
  findSessionBySessionId,
  getSessionsView,
  listSessionsForAgent,
  newSessionId,
  setActiveSession,
} from "./sessions";

function sessionsPath(agentFullId: string): string {
  return join(tmpHome, "agents", agentFullId, "sessions", "sessions.json");
}

function writeSessions(
  agentFullId: string,
  parsed: Record<string, unknown>,
): void {
  const path = sessionsPath(agentFullId);
  mkdirSync(join(tmpHome, "agents", agentFullId, "sessions"), {
    recursive: true,
  });
  writeFileSync(path, JSON.stringify(parsed), "utf8");
}

beforeEach(() => {
  cookieStore.clear();
  setCalls = [];
});

afterAll(() => {
  if (ORIGINAL_HOME) process.env.OPENCLAW_HOME = ORIGINAL_HOME;
  else delete process.env.OPENCLAW_HOME;
});

describe("listSessionsForAgent", () => {
  it("returns [] when the sessions.json file doesn't exist", () => {
    expect(listSessionsForAgent("nobody-cmo")).toEqual([]);
  });

  it("returns [] when the file is not valid JSON", () => {
    const agent = "broken-cmo";
    const p = sessionsPath(agent);
    mkdirSync(join(tmpHome, "agents", agent, "sessions"), { recursive: true });
    writeFileSync(p, "{ not json", "utf8");
    expect(listSessionsForAgent(agent)).toEqual([]);
  });

  it("parses sessions with the agent: prefix and strips it from label", () => {
    const agent = "demo-cmo";
    writeSessions(agent, {
      "agent:demo-cmo:main": { sessionId: "s1", updatedAt: 100 },
      "agent:demo-cmo:0xabc": { sessionId: "s2", lastInteractionAt: 200 },
    });
    const out = listSessionsForAgent(agent);
    expect(out.map((s) => s.label).sort()).toEqual(["0xabc", "main"]);
    // Newest-first: s2's lastInteractionAt is 200, larger than s1's 100.
    expect(out[0]!.sessionId).toBe("s2");
    expect(out[0]!.lastInteractionAt).toBe(200);
    expect(out[0]!.pending).toBe(false);
    expect(out[1]!.lastInteractionAt).toBe(100);
  });

  it("keeps the raw key as label when the prefix doesn't match", () => {
    const agent = "demo-cmo";
    writeSessions(agent, {
      "unusual-key-without-prefix": { sessionId: "s3", updatedAt: 1 },
    });
    const out = listSessionsForAgent(agent);
    expect(out[0]!.label).toBe("unusual-key-without-prefix");
  });

  it("skips entries with no sessionId", () => {
    const agent = "demo-cmo";
    writeSessions(agent, {
      "agent:demo-cmo:bad": { updatedAt: 1 },
      "agent:demo-cmo:good": { sessionId: "s-good", updatedAt: 5 },
    });
    const out = listSessionsForAgent(agent);
    expect(out.length).toBe(1);
    expect(out[0]!.sessionId).toBe("s-good");
  });

  it("falls back to updatedAt when lastInteractionAt missing, then to 0", () => {
    const agent = "demo-cmo";
    writeSessions(agent, {
      "agent:demo-cmo:a": { sessionId: "a", updatedAt: 50 },
      "agent:demo-cmo:b": { sessionId: "b" },
    });
    const out = listSessionsForAgent(agent);
    const byId = Object.fromEntries(out.map((s) => [s.sessionId, s]));
    expect(byId["a"]!.lastInteractionAt).toBe(50);
    expect(byId["b"]!.lastInteractionAt).toBe(0);
  });
});

describe("buildPendingSessionKey", () => {
  it("joins agent + sessionId with the `agent:` prefix", () => {
    expect(buildPendingSessionKey("demo-cmo", "uuid-1")).toBe(
      "agent:demo-cmo:uuid-1",
    );
  });
});

describe("findSessionBySessionId", () => {
  const agent = "demo-cmo";
  beforeEach(() => {
    writeSessions(agent, {
      "agent:demo-cmo:thread-label": {
        sessionId: "internal-uuid-1",
        updatedAt: 1,
      },
      "agent:demo-cmo:another": {
        sessionId: "internal-uuid-2",
        updatedAt: 2,
      },
    });
  });

  it("matches by label first", () => {
    const r = findSessionBySessionId(agent, "thread-label");
    expect(r?.sessionId).toBe("internal-uuid-1");
  });

  it("falls back to matching by internal sessionId", () => {
    const r = findSessionBySessionId(agent, "internal-uuid-2");
    expect(r?.sessionId).toBe("internal-uuid-2");
    expect(r?.label).toBe("another");
  });

  it("returns null when nothing matches", () => {
    expect(findSessionBySessionId(agent, "no-such-thread")).toBeNull();
  });
});

describe("newSessionId", () => {
  it("returns a UUID-shaped string", () => {
    const id = newSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Reasonably unique.
    expect(newSessionId()).not.toBe(id);
  });
});

describe("getSessionsView", () => {
  // The template `cmo` resolves to `<project>-cmo`.
  it("uses the existing top session when no cookie is set", async () => {
    writeSessions("alpha-cmo", {
      "agent:alpha-cmo:m1": { sessionId: "s1", updatedAt: 100 },
      "agent:alpha-cmo:m2": { sessionId: "s2", updatedAt: 200 },
    });
    const view = await getSessionsView("alpha", "cmo", "alpha-cmo");
    expect(view.active.sessionId).toBe("s2");
    expect(view.all.length).toBe(2);
    expect(view.active.pending).toBe(false);
  });

  it("synthesizes a fresh pending session when no sessions exist + no cookie", async () => {
    const view = await getSessionsView("beta", "cmo", "beta-cmo");
    expect(view.active.pending).toBe(true);
    expect(view.active.label).toBe("main");
    expect(view.active.sessionKey).toBe(
      `agent:beta-cmo:${view.active.sessionId}`,
    );
    // The synthetic active is prepended to `all`.
    expect(view.all.length).toBe(1);
    expect(view.all[0]).toBe(view.active);
  });

  it("uses the cookie's sessionId when it matches an existing session", async () => {
    writeSessions("gamma-cmo", {
      "agent:gamma-cmo:t-old": { sessionId: "old", updatedAt: 1 },
      "agent:gamma-cmo:t-new": { sessionId: "cookie-id", updatedAt: 2 },
    });
    cookieStore.set("notfair_active_session_gamma_cmo", "cookie-id");
    const view = await getSessionsView("gamma", "cmo", "gamma-cmo");
    expect(view.active.sessionId).toBe("cookie-id");
    expect(view.active.pending).toBe(false);
    // All sessions returned in newest-first order.
    expect(view.all.map((s) => s.sessionId)).toEqual(["cookie-id", "old"]);
  });

  it("treats unknown cookie sessionId as a pending session and prepends it", async () => {
    writeSessions("delta-cmo", {
      "agent:delta-cmo:t-real": { sessionId: "real-id", updatedAt: 1 },
    });
    cookieStore.set("notfair_active_session_delta_cmo", "imaginary-id");
    const view = await getSessionsView("delta", "cmo", "delta-cmo");
    expect(view.active.sessionId).toBe("imaginary-id");
    expect(view.active.pending).toBe(true);
    // Label is the first 8 chars of the cookie id.
    expect(view.active.label).toBe("imaginar");
    // The pending entry shows up at the front of `all`, with existing kept.
    expect(view.all[0]!.sessionId).toBe("imaginary-id");
    expect(view.all.find((s) => s.sessionId === "real-id")).toBeDefined();
  });
});

describe("setActiveSession", () => {
  it("writes the cookie with the expected name + opts", async () => {
    await setActiveSession("epsilon", "cmo", "fresh-uuid");
    expect(cookieStore.get("notfair_active_session_epsilon_cmo")).toBe(
      "fresh-uuid",
    );
    expect(setCalls.length).toBe(1);
    const opts = setCalls[0]!.opts as {
      httpOnly: boolean;
      sameSite: string;
      path: string;
      maxAge: number;
    };
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    // 1 year (365d) approx.
    expect(opts.maxAge).toBe(60 * 60 * 24 * 365);
  });
});
