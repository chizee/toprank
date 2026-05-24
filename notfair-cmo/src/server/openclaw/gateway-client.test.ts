import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Fake WebSocket implementation (hoisted so vi.mock can reference it)
// ---------------------------------------------------------------------------
//
// gateway-client only exercises a small slice of `ws`'s surface:
//   - constructor(url, opts)
//   - .once("open" | "error", fn)
//   - .removeListener("error", fn)
//   - .on("message" | "close" | "error", fn)
//   - .send(string)
//   - .close()
//   - .readyState (compared against the static `OPEN` constant)
//
// We back the fake with EventEmitter so .on / .once / .removeListener all
// behave correctly without re-implementing them.

const { FakeWS } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");

  class FakeWSImpl extends EE {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    readyState: number = 0;
    readonly url: string;
    readonly opts: Record<string, unknown>;
    readonly sent: string[] = [];
    closed = false;

    constructor(url: string, opts: Record<string, unknown> = {}) {
      super();
      this.url = url;
      this.opts = opts;
      FakeWSImpl.instances.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.closed = true;
      this.readyState = FakeWSImpl.CLOSED;
      setImmediate(() => this.emit("close"));
    }

    fireOpen(): void {
      this.readyState = FakeWSImpl.OPEN;
      this.emit("open");
    }
    fireMessage(frame: unknown): void {
      this.emit("message", JSON.stringify(frame));
    }
    fireError(err: Error): void {
      this.emit("error", err);
    }
    fireClose(): void {
      this.readyState = FakeWSImpl.CLOSED;
      this.emit("close");
    }

    static instances: FakeWSImpl[] = [];
    static reset(): void {
      FakeWSImpl.instances = [];
    }
    static latest(): FakeWSImpl {
      return FakeWSImpl.instances[FakeWSImpl.instances.length - 1]!;
    }
  }

  return { FakeWS: FakeWSImpl };
});

type FakeWST = InstanceType<typeof FakeWS>;

vi.mock("ws", () => ({
  default: FakeWS,
  WebSocket: FakeWS,
}));

// ---------------------------------------------------------------------------
// Set up a fake OPENCLAW_HOME with a discovery file so discoverGateway()
// returns a known URL + token.
// ---------------------------------------------------------------------------

const { tmpHome, ORIGINAL_HOME, ORIGINAL_STATE } = ((): {
  tmpHome: string;
  ORIGINAL_HOME: string | undefined;
  ORIGINAL_STATE: string | undefined;
} => {
  const origHome = process.env.OPENCLAW_HOME;
  const origState = process.env.OPENCLAW_STATE_DIR;
  const tmp = mkdtempSync(join(tmpdir(), "notfair-cmo-gateway-"));
  process.env.OPENCLAW_HOME = tmp;
  delete process.env.OPENCLAW_STATE_DIR;
  return { tmpHome: tmp, ORIGINAL_HOME: origHome, ORIGINAL_STATE: origState };
})();

function writeConfig(parsed: unknown): void {
  writeFileSync(join(tmpHome, "openclaw.json"), JSON.stringify(parsed), "utf8");
}

// Default config used by most tests.
beforeAll(() => {
  writeConfig({
    gateway: {
      port: 7799,
      bind: "loopback",
      auth: { token: "tok-abc" },
    },
  });
});

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
  if (ORIGINAL_HOME) process.env.OPENCLAW_HOME = ORIGINAL_HOME;
  else delete process.env.OPENCLAW_HOME;
  if (ORIGINAL_STATE) process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE;
});

// Late import so the env + mocks are in place.
import {
  discoverGateway,
  GatewayClient,
  streamChatViaGateway,
} from "./gateway-client";

beforeEach(() => {
  // Don't reset between every test — the streamChatViaGateway singleton
  // retains a ws reference across tests. Individual GatewayClient tests
  // construct a fresh client + ws each time, so a stale instances list
  // is fine for them too (they call FakeWS.latest() after constructing).
});

// ---------------------------------------------------------------------------
// discoverGateway
// ---------------------------------------------------------------------------

describe("discoverGateway", () => {
  it("reads port + token from openclaw.json (loopback default)", () => {
    const cfg = discoverGateway();
    expect(cfg.url).toBe("ws://127.0.0.1:7799");
    expect(cfg.token).toBe("tok-abc");
    expect(cfg.password).toBeUndefined();
    expect(cfg.configFile).toBe(join(tmpHome, "openclaw.json"));
  });

  it("prefers gateway.remote.url when present", () => {
    writeConfig({
      gateway: {
        port: 1,
        remote: { url: "wss://my-tailnet:9999  " },
        auth: { token: "remote-tok" },
      },
    });
    const cfg = discoverGateway();
    expect(cfg.url).toBe("wss://my-tailnet:9999");
    // Restore default config for downstream tests.
    writeConfig({
      gateway: { port: 7799, bind: "loopback", auth: { token: "tok-abc" } },
    });
  });

  it("uses 127.0.0.1 even on bind='lan' when remote.url is not set", () => {
    writeConfig({
      gateway: { port: 1234, bind: "lan", auth: { password: "pw" } },
    });
    const cfg = discoverGateway();
    expect(cfg.url).toBe("ws://127.0.0.1:1234");
    expect(cfg.token).toBeUndefined();
    expect(cfg.password).toBe("pw");
    writeConfig({
      gateway: { port: 7799, bind: "loopback", auth: { token: "tok-abc" } },
    });
  });

  it("throws when the config file does not exist", () => {
    const prev = process.env.OPENCLAW_HOME;
    const missing = mkdtempSync(join(tmpdir(), "notfair-cmo-missing-"));
    rmSync(missing, { recursive: true, force: true });
    process.env.OPENCLAW_HOME = missing;
    try {
      expect(() => discoverGateway()).toThrow(/OpenClaw config not found/);
    } finally {
      process.env.OPENCLAW_HOME = prev;
    }
  });

  it("throws when the config file is not JSON", () => {
    const bad = mkdtempSync(join(tmpdir(), "notfair-cmo-bad-"));
    process.env.OPENCLAW_HOME = bad;
    writeFileSync(join(bad, "openclaw.json"), "{ not valid", "utf8");
    try {
      expect(() => discoverGateway()).toThrow(/Could not parse/);
    } finally {
      process.env.OPENCLAW_HOME = tmpHome;
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it("throws when gateway.port is missing/invalid and no remote.url", () => {
    writeConfig({ gateway: { bind: "loopback" } });
    try {
      expect(() => discoverGateway()).toThrow(/Could not read gateway\.port/);
    } finally {
      writeConfig({
        gateway: { port: 7799, bind: "loopback", auth: { token: "tok-abc" } },
      });
    }
  });

  it("respects OPENCLAW_STATE_DIR over OPENCLAW_HOME", () => {
    const state = mkdtempSync(join(tmpdir(), "notfair-cmo-state-"));
    writeFileSync(
      join(state, "openclaw.json"),
      JSON.stringify({
        gateway: { port: 5555, bind: "loopback", auth: {} },
      }),
      "utf8",
    );
    process.env.OPENCLAW_STATE_DIR = state;
    try {
      const cfg = discoverGateway();
      expect(cfg.url).toBe("ws://127.0.0.1:5555");
      expect(cfg.configFile).toBe(join(state, "openclaw.json"));
    } finally {
      delete process.env.OPENCLAW_STATE_DIR;
      rmSync(state, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GatewayClient: open / connect handshake
// ---------------------------------------------------------------------------

describe("GatewayClient.open", () => {
  /**
   * Helper: drive a GatewayClient through the open handshake.
   * Returns the connected client + the underlying FakeWS so the test can
   * push more frames after.
   */
  async function openAndAck(): Promise<{ client: GatewayClient; ws: FakeWST }> {
    const client = new GatewayClient();
    const openP = client.open();
    // After microtasks, the constructor + ws creation should have happened.
    await tick();
    const ws = FakeWS.latest();
    ws.fireOpen();
    // Now the client sends the `connect` req frame. Pull it + ack.
    await tick();
    const reqRaw = ws.sent[0];
    expect(reqRaw).toBeDefined();
    const req = JSON.parse(reqRaw!) as { id: string; method: string };
    expect(req.method).toBe("connect");
    ws.fireMessage({ type: "res", id: req.id, ok: true, payload: { protocol: 4 } });
    await openP;
    return { client, ws };
  }

  it("constructs a WebSocket with the discovered URL", async () => {
    const { client, ws } = await openAndAck();
    expect(ws.url).toBe("ws://127.0.0.1:7799");
    // perMessageDeflate disabled + 5s handshake timeout (loopback is fast).
    expect(ws.opts.perMessageDeflate).toBe(false);
    expect(ws.opts.handshakeTimeout).toBe(5_000);
    expect(client.isOpen()).toBe(true);
    client.close();
  });

  it("uses opts.url / opts.token over discovery values", async () => {
    const client = new GatewayClient({
      url: "ws://override:1234",
      token: "ovr-tok",
      scopes: ["operator.read"],
    });
    const p = client.open();
    await tick();
    const ws = FakeWS.latest();
    expect(ws.url).toBe("ws://override:1234");
    ws.fireOpen();
    await tick();
    const req = JSON.parse(ws.sent[0]!) as {
      params: { auth?: { token?: string }; scopes?: string[] };
    };
    expect(req.params.auth?.token).toBe("ovr-tok");
    expect(req.params.scopes).toEqual(["operator.read"]);
    ws.fireMessage({
      type: "res",
      id: (JSON.parse(ws.sent[0]!) as { id: string }).id,
      ok: true,
    });
    await p;
    client.close();
  });

  it("open() is idempotent — second call resolves without a new socket", async () => {
    const { client, ws } = await openAndAck();
    const before = FakeWS.instances.length;
    await client.open();
    expect(FakeWS.instances.length).toBe(before);
    client.close();
  });

  it("concurrent open() calls share the same in-flight promise", async () => {
    const baseline = FakeWS.instances.length;
    const client = new GatewayClient();
    const a = client.open();
    const b = client.open();
    await tick();
    // Only one new socket should have been constructed.
    expect(FakeWS.instances.length - baseline).toBe(1);
    const ws = FakeWS.latest();
    ws.fireOpen();
    await tick();
    const id = (JSON.parse(ws.sent[0]!) as { id: string }).id;
    ws.fireMessage({ type: "res", id, ok: true });
    await Promise.all([a, b]);
    expect(client.isOpen()).toBe(true);
    client.close();
  });

  it("rejects when the socket errors before opening", async () => {
    const client = new GatewayClient();
    const p = client.open();
    await tick();
    const ws = FakeWS.latest();
    ws.fireError(new Error("conn refused"));
    await expect(p).rejects.toThrow(/conn refused/);
    expect(client.isOpen()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GatewayClient.request — pending / response routing
// ---------------------------------------------------------------------------

describe("GatewayClient.request", () => {
  async function openAndAck(): Promise<{ client: GatewayClient; ws: FakeWST }> {
    const client = new GatewayClient();
    const openP = client.open();
    await tick();
    const ws = FakeWS.latest();
    ws.fireOpen();
    await tick();
    const id = (JSON.parse(ws.sent[0]!) as { id: string }).id;
    ws.fireMessage({ type: "res", id, ok: true });
    await openP;
    return { client, ws };
  }

  it("resolves with payload when server returns ok:true", async () => {
    const { client, ws } = await openAndAck();
    const p = client.request("foo.bar", { x: 1 });
    await tick();
    const req = JSON.parse(ws.sent[ws.sent.length - 1]!) as {
      id: string;
      method: string;
      params: unknown;
    };
    expect(req.method).toBe("foo.bar");
    expect(req.params).toEqual({ x: 1 });
    ws.fireMessage({ type: "res", id: req.id, ok: true, payload: { hello: "world" } });
    await expect(p).resolves.toEqual({ hello: "world" });
    client.close();
  });

  it("rejects with formatted error message when ok:false", async () => {
    const { client, ws } = await openAndAck();
    const p = client.request("foo.bar");
    await tick();
    const id = (JSON.parse(ws.sent[ws.sent.length - 1]!) as { id: string }).id;
    ws.fireMessage({
      type: "res",
      id,
      ok: false,
      error: { code: "FORBIDDEN", message: "no", details: { why: "scope" } },
    });
    await expect(p).rejects.toThrow(/gateway error \(FORBIDDEN\): no/);
    await expect(p.catch((e) => (e as Error).message)).resolves.toMatch(
      /details=.*scope/,
    );
    client.close();
  });

  it("rejects with default UNKNOWN code when error envelope is missing fields", async () => {
    const { client, ws } = await openAndAck();
    const p = client.request("foo.bar");
    await tick();
    const id = (JSON.parse(ws.sent[ws.sent.length - 1]!) as { id: string }).id;
    ws.fireMessage({ type: "res", id, ok: false });
    await expect(p).rejects.toThrow(/gateway error \(UNKNOWN\): request failed/);
    client.close();
  });

  it("rejects request when socket is closed", async () => {
    const client = new GatewayClient();
    await expect(client.request("foo")).rejects.toThrow(/gateway not connected/);
  });

  it("rejects all pending requests on close event", async () => {
    const { client, ws } = await openAndAck();
    const a = client.request("a");
    const b = client.request("b");
    await tick();
    ws.fireClose();
    await Promise.all([
      expect(a).rejects.toThrow(/gateway connection closed/),
      expect(b).rejects.toThrow(/gateway connection closed/),
    ]);
    client.close();
  });

  it("ignores response frames for unknown ids (no crash)", async () => {
    const { client, ws } = await openAndAck();
    // Unmatched id — should silently noop.
    ws.fireMessage({ type: "res", id: "no-such-id", ok: true });
    // Subsequent legit request still works.
    const p = client.request("foo");
    await tick();
    const id = (JSON.parse(ws.sent[ws.sent.length - 1]!) as { id: string }).id;
    ws.fireMessage({ type: "res", id, ok: true, payload: 42 });
    await expect(p).resolves.toBe(42);
    client.close();
  });

  it("ignores frames that aren't valid JSON", async () => {
    const { client, ws } = await openAndAck();
    ws.emit("message", "{not json"); // direct emit bypasses fireMessage's stringify
    const p = client.request("foo");
    await tick();
    const id = (JSON.parse(ws.sent[ws.sent.length - 1]!) as { id: string }).id;
    ws.fireMessage({ type: "res", id, ok: true });
    await expect(p).resolves.toBeUndefined();
    client.close();
  });
});

// ---------------------------------------------------------------------------
// Event listener dispatch
// ---------------------------------------------------------------------------

describe("GatewayClient.addEventListener", () => {
  async function openAndAck(): Promise<{ client: GatewayClient; ws: FakeWST }> {
    const client = new GatewayClient();
    const p = client.open();
    await tick();
    const ws = FakeWS.latest();
    ws.fireOpen();
    await tick();
    const id = (JSON.parse(ws.sent[0]!) as { id: string }).id;
    ws.fireMessage({ type: "res", id, ok: true });
    await p;
    return { client, ws };
  }

  it("dispatches event-typed frames to subscribers", async () => {
    const { client, ws } = await openAndAck();
    const received: unknown[] = [];
    const off = client.addEventListener((evt) => received.push(evt));
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: { hi: 1 },
    });
    expect(received).toHaveLength(1);
    off();
    ws.fireMessage({ type: "event", event: "chat", payload: { hi: 2 } });
    expect(received).toHaveLength(1);
    client.close();
  });

  it("swallows listener throws so other listeners still see the frame", async () => {
    const { client, ws } = await openAndAck();
    const a = vi.fn().mockImplementation(() => {
      throw new Error("listener exploded");
    });
    const b = vi.fn();
    client.addEventListener(a);
    client.addEventListener(b);
    // Silence the console.error call from the SUT's catch block.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ws.fireMessage({ type: "event", event: "chat", payload: {} });
    } finally {
      spy.mockRestore();
    }
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    client.close();
  });

  it("filters out connect.challenge events (device-auth, not for loopback)", async () => {
    const { client, ws } = await openAndAck();
    const seen: unknown[] = [];
    client.addEventListener((e) => seen.push(e.event));
    ws.fireMessage({ type: "event", event: "connect.challenge", payload: {} });
    ws.fireMessage({ type: "event", event: "chat", payload: {} });
    expect(seen).toEqual(["chat"]);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// close() cleanup
// ---------------------------------------------------------------------------

describe("GatewayClient.close", () => {
  it("clears listeners + pending + nulls out ws", async () => {
    const client = new GatewayClient();
    const p = client.open();
    await tick();
    const ws = FakeWS.latest();
    ws.fireOpen();
    await tick();
    const id = (JSON.parse(ws.sent[0]!) as { id: string }).id;
    ws.fireMessage({ type: "res", id, ok: true });
    await p;

    expect(client.isOpen()).toBe(true);
    client.close();
    expect(client.isOpen()).toBe(false);
    // After close, request rejects.
    await expect(client.request("x")).rejects.toThrow(/not connected/);
  });

  it("close() is safe to call before open()", () => {
    const client = new GatewayClient();
    expect(() => client.close()).not.toThrow();
    expect(client.isOpen()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streamChatViaGateway (high-level helper)
// ---------------------------------------------------------------------------

describe("streamChatViaGateway", () => {
  // The streaming helper uses a process-singleton client. Tests must NOT
  // assume a clean slate between runs — but since each test issues its own
  // chat.send and aborts shortly after, the shared client just gets reused.
  //
  // To exercise the singleton end-to-end without timing flakes, each test
  // here aborts immediately after a few frames so the generator terminates.

  /**
   * Returns an iteration wrapper that handles the gotcha of starting an
   * async generator: gen.next() must be called to begin execution, but
   * its returned value is the first yielded event. We capture it and
   * surface it via `events()` so tests see ALL events.
   */
  async function bootstrapStream(input: {
    sessionKey: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<{
    ws: FakeWST;
    /** Drains the generator and returns all yielded events. */
    drain: () => Promise<unknown[]>;
    sendReqId: string;
  }> {
    const baselineCount = FakeWS.instances.length;
    const gen = streamChatViaGateway(input) as AsyncGenerator<unknown, void, void>;
    // Start the generator (this also triggers the chat.send req). We hold the
    // promise so the first yielded event isn't dropped.
    const firstResultPromise = gen.next();
    // Allow the singleton bootstrap to run if needed.
    await tick();
    let ws: FakeWST;
    if (FakeWS.instances.length > baselineCount) {
      ws = FakeWS.latest();
      ws.fireOpen();
      await tick();
      const connectId = (JSON.parse(ws.sent[0]!) as { id: string }).id;
      ws.fireMessage({ type: "res", id: connectId, ok: true });
      await tick();
    } else {
      ws = FakeWS.latest();
    }
    const lastSent = ws.sent[ws.sent.length - 1]!;
    const sendReqId = (JSON.parse(lastSent) as { id: string }).id;

    const drain = async (): Promise<unknown[]> => {
      const out: unknown[] = [];
      const first = await firstResultPromise;
      if (!first.done) out.push(first.value);
      // Now iterate the rest.
      for (;;) {
        const r = await gen.next();
        if (r.done) break;
        out.push(r.value);
      }
      return out;
    };
    return { ws, drain, sendReqId };
  }

  it("yields delta + final events when chat state goes final", async () => {
    const ac = new AbortController();
    const { ws, drain, sendReqId } = await bootstrapStream({
      sessionKey: "session-A",
      message: "hi",
      signal: ac.signal,
    });
    ws.fireMessage({ type: "res", id: sendReqId, ok: true, payload: {} });
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "session-A",
        state: "delta",
        message: { content: [{ type: "text", text: "hello" }] },
      },
    });
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "session-A",
        state: "final",
        message: { content: [{ type: "text", text: "hello world" }] },
      },
    });

    const out = await drain();
    const kinds = out.map((e) => (e as { kind: string }).kind);
    expect(kinds).toContain("delta");
    expect(kinds).toContain("final");
    const finalEv = out.find((e) => (e as { kind: string }).kind === "final") as {
      text: string;
    };
    expect(finalEv.text).toBe("hello world");
  });

  it("ignores events for a different sessionKey", async () => {
    const { ws, drain, sendReqId } = await bootstrapStream({
      sessionKey: "session-B",
      message: "hi",
    });
    ws.fireMessage({ type: "res", id: sendReqId, ok: true, payload: {} });
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "other-session",
        state: "delta",
        message: { content: [{ type: "text", text: "should be ignored" }] },
      },
    });
    // Final for our session with content (so we don't hit the chat.history
    // fallback that retries for ~640ms).
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "session-B",
        state: "final",
        message: { content: [{ type: "text", text: "ours" }] },
      },
    });

    const out = await drain();
    const finalEv = out.find((e) => (e as { kind: string }).kind === "final") as {
      text: string;
    };
    expect(finalEv).toBeDefined();
    expect(finalEv.text).toBe("ours");
    // None of the deltas should contain "should be ignored".
    const deltas = out
      .filter((e) => (e as { kind: string }).kind === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(deltas).not.toContain("should be ignored");
  });

  it("emits tool events with phase + name + label", async () => {
    const { ws, drain, sendReqId } = await bootstrapStream({
      sessionKey: "session-C",
      message: "hi",
    });
    ws.fireMessage({ type: "res", id: sendReqId, ok: true, payload: {} });

    ws.fireMessage({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: "session-C",
        stream: "tool",
        data: {
          phase: "start",
          name: "exec",
          toolCallId: "tc-1",
          args: { command: "pnpm test" },
        },
      },
    });
    ws.fireMessage({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: "session-C",
        stream: "tool",
        data: { phase: "result", name: "exec", toolCallId: "tc-1" },
      },
    });
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "session-C",
        state: "final",
        message: { content: [{ type: "text", text: "done" }] },
      },
    });

    const out = await drain();
    const toolEvs = out.filter((e) => (e as { kind: string }).kind === "tool") as Array<{
      phase: string;
      label?: string;
    }>;
    expect(toolEvs.length).toBe(2);
    expect(toolEvs[0]!.phase).toBe("start");
    expect(toolEvs[0]!.label).toBe("pnpm test");
    expect(toolEvs[1]!.phase).toBe("result");
  });

  it("emits lifecycle events from data.phase and payload.state", async () => {
    const { ws, drain, sendReqId } = await bootstrapStream({
      sessionKey: "session-D",
      message: "hi",
    });
    ws.fireMessage({ type: "res", id: sendReqId, ok: true, payload: {} });

    ws.fireMessage({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: "session-D",
        stream: "lifecycle",
        data: { phase: "start" },
      },
    });
    ws.fireMessage({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: "session-D",
        stream: "lifecycle",
        state: "end",
      },
    });
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "session-D",
        state: "final",
        message: { content: [{ type: "text", text: "done" }] },
      },
    });

    const out = await drain();
    const lifecycle = (out.filter((e) => (e as { kind: string }).kind === "lifecycle") as Array<{
      phase: string;
    }>).map((e) => e.phase);
    expect(lifecycle).toEqual(["start", "end"]);
  });

  it("coalesces assistant deltas + replace into a monotonic stream", async () => {
    const { ws, drain, sendReqId } = await bootstrapStream({
      sessionKey: "session-E",
      message: "hi",
    });
    ws.fireMessage({ type: "res", id: sendReqId, ok: true, payload: {} });

    ws.fireMessage({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: "session-E",
        stream: "assistant",
        data: { delta: "Hel" },
      },
    });
    ws.fireMessage({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: "session-E",
        stream: "assistant",
        data: { delta: "lo" },
      },
    });
    ws.fireMessage({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: "session-E",
        stream: "assistant",
        data: { replace: true, text: "Hello world" },
      },
    });
    ws.fireMessage({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "session-E",
        state: "final",
        message: { content: [{ type: "text", text: "Hello world" }] },
      },
    });

    const out = await drain();
    const text = (out.filter((e) => (e as { kind: string }).kind === "delta") as Array<{
      text: string;
    }>)
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  it("aborts via signal: fires chat.abort and terminates", async () => {
    const ac = new AbortController();
    const { ws, drain } = await bootstrapStream({
      sessionKey: "session-F",
      message: "hi",
      signal: ac.signal,
    });
    const sentBefore = ws.sent.length;
    ac.abort();
    const out = await drain();
    expect(out).toBeDefined();
    // The abort path sends a chat.abort request (we don't bother to ack it).
    expect(ws.sent.length).toBeGreaterThan(sentBefore);
    const lastSent = JSON.parse(ws.sent[ws.sent.length - 1]!) as { method: string };
    expect(lastSent.method).toBe("chat.abort");
  });

  it("emits error event when chat.send is rejected by the gateway", async () => {
    const { ws, drain, sendReqId } = await bootstrapStream({
      sessionKey: "session-G",
      message: "hi",
    });
    ws.fireMessage({
      type: "res",
      id: sendReqId,
      ok: false,
      error: { code: "RATE_LIMITED", message: "slow down" },
    });

    const out = await drain();
    const errEv = out.find((e) => (e as { kind: string }).kind === "error") as {
      message: string;
    };
    expect(errEv).toBeDefined();
    expect(errEv.message).toMatch(/RATE_LIMITED/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance microtasks + immediate timers. */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

afterEach(() => {
  // Nothing to clean up beyond resetting fake WS — singleton from
  // streamChatViaGateway is intentionally retained.
});
