import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

/**
 * Minimal OpenClaw Gateway WebSocket client for streaming chat.
 *
 * Wire protocol (lifted from openclaw/openclaw `ui/src/ui/gateway.ts`):
 *   - Open WS to ws://<host>:<port>
 *   - Server may emit `event: connect.challenge` with a nonce; we ignore for
 *     token-only auth on loopback.
 *   - Client sends `{ type: "req", id, method: "connect", params: {...} }`
 *     with auth.token; server replies `{ type: "res", ok: true, payload: helloOk }`.
 *   - All requests use `{ type: "req", id, method, params }` and receive
 *     `{ type: "res", id, ok, payload?, error? }`.
 *   - Streaming chat tokens arrive as `{ type: "event", event: "chat", payload }`
 *     events; payload includes { runId, sessionKey, state, deltaText, message }.
 *
 * URL + token discovery: read OpenClaw's own config file. We never hard-code
 * port or host — the user's `~/.openclaw/openclaw.json` (or
 * `OPENCLAW_STATE_DIR`/profile path) is the source of truth.
 */

// --- Discovery ---

export type GatewayConfig = {
  url: string; // ws://host:port
  token?: string;
  password?: string;
  configFile: string;
};

function resolveConfigFile(): string {
  const dir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.OPENCLAW_HOME?.trim() ||
    join(homedir(), ".openclaw");
  return join(dir, "openclaw.json");
}

export function discoverGateway(): GatewayConfig {
  const configFile = resolveConfigFile();
  if (!existsSync(configFile)) {
    throw new Error(
      `OpenClaw config not found at ${configFile}. Is OpenClaw installed and configured?`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Could not parse ${configFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const gateway = (parsed.gateway ?? {}) as Record<string, unknown>;

  // Prefer remote URL if user configured one; otherwise build from port + bind.
  const remote = (gateway.remote ?? {}) as Record<string, unknown>;
  const remoteUrl = typeof remote.url === "string" ? remote.url.trim() : "";
  let url = remoteUrl;

  if (!url) {
    const port = Number(gateway.port);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Could not read gateway.port from ${configFile}`);
    }
    const bind = typeof gateway.bind === "string" ? gateway.bind : "loopback";
    // For loopback/auto, connect to 127.0.0.1. For lan/tailnet, the user
    // typically also sets gateway.remote.url; if not, loopback is the safest
    // local default.
    const host = bind === "lan" || bind === "tailnet" ? "127.0.0.1" : "127.0.0.1";
    url = `ws://${host}:${port}`;
  }

  const auth = (gateway.auth ?? {}) as Record<string, unknown>;
  const token = typeof auth.token === "string" && auth.token.length > 0 ? auth.token : undefined;
  const password =
    typeof auth.password === "string" && auth.password.length > 0 ? auth.password : undefined;

  return { url, token, password, configFile };
}

// --- Frame types ---

type ReqFrame = { type: "req"; id: string; method: string; params?: unknown };
type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};
type EventFrame = { type: "event"; event: string; payload?: unknown; seq?: number };
type AnyFrame = ResFrame | EventFrame | { type: string; [k: string]: unknown };

// Wide protocol range so the gateway picks whatever it supports. Older
// installs speak protocol 3; newer ones speak 4+. The server returns the
// chosen version in hello-ok.
const CLIENT_MIN_PROTOCOL = 2 as const;
const CLIENT_MAX_PROTOCOL = 10 as const;

export type GatewayConnectOptions = {
  /** override discovery. */
  url?: string;
  token?: string;
  password?: string;
  /** scopes to request; default operator.read + write (enough for chat.send). */
  scopes?: string[];
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (err: Error) => void }
  >();
  private eventListeners = new Set<(evt: EventFrame) => void>();
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private readonly cfg: GatewayConfig;
  private readonly scopes: string[];

  constructor(opts: GatewayConnectOptions = {}) {
    const discovered = discoverGateway();
    this.cfg = {
      url: opts.url ?? discovered.url,
      token: opts.token ?? discovered.token,
      password: opts.password ?? discovered.password,
      configFile: discovered.configFile,
    };
    // Local single-user app; default to admin so config mutations (skills.update,
    // crons CRUD) work without per-call scope juggling.
    this.scopes = opts.scopes ?? [
      "operator.read",
      "operator.write",
      "operator.admin",
    ];
  }

  /** Open + connect, idempotent. */
  async open(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async openInternal(): Promise<void> {
    const ws = new WebSocket(this.cfg.url, {
      perMessageDeflate: false,
      handshakeTimeout: 5_000,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      ws.once("error", onErr);
      ws.once("open", () => {
        ws.removeListener("error", onErr);
        resolve();
      });
    });

    ws.on("message", (raw) => this.handleMessage(String(raw)));
    ws.on("close", () => {
      this.connected = false;
      for (const p of this.pending.values()) {
        p.reject(new Error("gateway connection closed"));
      }
      this.pending.clear();
    });
    ws.on("error", () => {
      // Errors after open propagate via close.
    });

    // Send connect frame and wait for hello-ok payload.
    await this.request("connect", {
      minProtocol: CLIENT_MIN_PROTOCOL,
      maxProtocol: CLIENT_MAX_PROTOCOL,
      client: {
        id: "gateway-client",
        version: "0.1.0",
        platform: process.platform,
        mode: "backend",
        instanceId: process.pid.toString(),
      },
      role: "operator",
      scopes: this.scopes,
      // "tool-events" opts us into the tool-event broadcast stream. Without
      // this, the gateway gates those frames per `server-methods/chat.ts`
      // (`registerToolEventRecipient` only fires when the cap is present), so
      // the whole `stream:"tool"` channel goes dark — even though everything
      // else (assistant deltas, lifecycle, chat) still arrives.
      caps: ["tool-events"],
      ...(this.cfg.token || this.cfg.password
        ? { auth: { token: this.cfg.token, password: this.cfg.password } }
        : {}),
      userAgent: `notfair-cmo/0.1.0 node/${process.versions.node}`,
      locale: "en-US",
    });
    this.connected = true;
  }

  close(): void {
    this.connected = false;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.pending.clear();
    this.eventListeners.clear();
  }

  isOpen(): boolean {
    return this.connected && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = randomUUID();
    const frame: ReqFrame = { type: "req", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      ws.send(JSON.stringify(frame));
    });
  }

  addEventListener(listener: (evt: EventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private handleMessage(raw: string): void {
    let parsed: AnyFrame;
    try {
      parsed = JSON.parse(raw) as AnyFrame;
    } catch {
      return;
    }
    if (parsed.type === "res") {
      const res = parsed as ResFrame;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.payload);
      else {
        const detailsStr = res.error?.details
          ? ` details=${JSON.stringify(res.error.details).slice(0, 300)}`
          : "";
        p.reject(
          new Error(
            `gateway error (${res.error?.code ?? "UNKNOWN"}): ${res.error?.message ?? "request failed"}${detailsStr}`,
          ),
        );
      }
      return;
    }
    if (parsed.type === "event") {
      const evt = parsed as EventFrame;
      // connect.challenge is for device auth; we don't use it on loopback +
      // shared-token. Safe to ignore.
      if (evt.event === "connect.challenge") return;
      for (const listener of this.eventListeners) {
        try {
          listener(evt);
        } catch (err) {
          console.error("[gateway-client] event listener error:", err);
        }
      }
    }
  }
}

// --- High-level streaming chat helper ---

export type StreamChatInput = {
  sessionKey: string;
  sessionId?: string;
  message: string;
  /** Cancellation signal. When aborted, we issue chat.abort and stop. */
  signal?: AbortSignal;
  /** Optional profiler — caller passes a ChatPerf to receive timing marks. */
  perf?: ChatPerf;
};

export type ChatPerf = {
  mark(name: string): void;
};

export type ChatStreamEvent =
  | { kind: "delta"; text: string }
  | {
      kind: "tool";
      /**
       * OpenClaw emits start → (update*) → result for each tool invocation.
       * We surface all three so the UI can show in-progress + final state.
       */
      phase: "start" | "update" | "result";
      /** Stable id per tool invocation; lets the UI update the right row. */
      toolCallId: string;
      /** Raw tool name (e.g. "exec", "read", "edit", or "mcp:foo.bar"). */
      name: string;
      /**
       * Human-readable one-liner the UI shows next to the tool name
       * (e.g. command for exec, path for read/write). Pre-computed on the
       * server so the client doesn't need to know every tool's args shape.
       */
      label?: string;
    }
  | {
      kind: "lifecycle";
      /** "start" | "end" | "error" — useful for UI heartbeat / "agent is working". */
      phase: string;
    }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string };

/**
 * Process-wide singleton gateway client.
 *
 * Why: opening a fresh WebSocket per chat turn was costing ~10-30 ms for the
 * TCP+WS handshake plus a `connect`/hello round-trip (see `[chat-perf]`
 * traces). Reusing one connection across turns eliminates that overhead.
 *
 * Resilience: if the underlying socket closes (OpenClaw restarted), `isOpen()`
 * returns false and we lazily reconnect on the next call.
 */
let sharedClient: GatewayClient | null = null;
let sharedClientPromise: Promise<GatewayClient> | null = null;

/**
 * Returns the shared singleton gateway client, lazily creating it on first
 * call. The promise cache makes concurrent callers await the SAME in-flight
 * connect — without it, two callers arriving before the first open()
 * completes would each create a fresh GatewayClient, opening two WebSockets
 * and racing each other's connect handshake against the OpenClaw gateway
 * (which rejects any frame before a connect with "invalid handshake: first
 * request must be connect"). React StrictMode double-mounting client
 * effects in Next dev was the easiest reproducer.
 */
async function getSharedClient(): Promise<GatewayClient> {
  if (sharedClient && sharedClient.isOpen()) return sharedClient;
  if (sharedClientPromise) return sharedClientPromise;
  sharedClientPromise = (async () => {
    const candidate = new GatewayClient();
    try {
      await candidate.open();
      sharedClient = candidate;
      return candidate;
    } finally {
      sharedClientPromise = null;
    }
  })();
  return sharedClientPromise;
}

/**
 * Stream a chat turn from OpenClaw. Yields incremental delta text events as
 * the agent produces tokens, then a final event with the full text once done.
 *
 * Three text channels are coalesced into a single monotonically-growing
 * transcript and surfaced as delta events:
 *   1. `event: "agent"`, `stream: "assistant"` — true token-by-token streaming
 *      from providers that support it. Carries `data.delta` (incremental) or
 *      `data.text` (full text-so-far when `replace: true`).
 *   2. `event: "chat"`, `state: "delta"` — provider-buffered streaming with
 *      the merged text in `message.content[0].text`.
 *   3. `chat.history` fallback — for deltaless providers (codex/gpt-5.5) the
 *      assistant text only appears in the persisted transcript. After the
 *      terminal `chat` event we poll `chat.history` until an assistant message
 *      timestamped at-or-after `turnStartedAt` shows up.
 */
export async function* streamChatViaGateway(
  input: StreamChatInput,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const perf = input.perf;
  perf?.mark("gw_open_start");
  let client: GatewayClient;
  try {
    client = await getSharedClient();
  } catch (err) {
    // First-time failure means the cached null instance is fine — the next
    // call will retry. Surface error to the caller.
    sharedClient = null;
    throw err;
  }
  perf?.mark("gw_open_end");

  const runId = randomUUID();
  const turnStartedAt = Date.now();
  const events: ChatStreamEvent[] = [];
  let done = false;
  let lastEmittedLen = 0;
  let resolveWait: (() => void) | null = null;
  let firstEventSeen = false;
  let firstDeltaEmitted = false;

  const wake = () => {
    if (resolveWait) {
      const r = resolveWait;
      resolveWait = null;
      r();
    }
  };

  // Helper: emit a delta consisting of the suffix beyond what we've already
  // shown the client. Coalesces text coming from agent-stream events (live
  // tokens), chat-state delta events (provider-buffered), and the final
  // chat.history fallback into a single monotonically-growing transcript.
  const emitMergedText = (merged: string) => {
    if (merged.length <= lastEmittedLen) return;
    const delta = merged.slice(lastEmittedLen);
    lastEmittedLen = merged.length;
    if (!firstDeltaEmitted) {
      firstDeltaEmitted = true;
      perf?.mark("gw_first_delta");
    }
    events.push({ kind: "delta", text: delta });
    wake();
  };

  // Agent text deltas: OpenClaw streams live assistant tokens via
  // `event: "agent"` with `stream: "assistant"`, payload.data.delta = the new
  // characters. Older bursts (e.g., the first chunk on a deltaless provider)
  // arrive as data.text containing the full text-so-far instead. Handle both.
  let agentAssistantBuffer = "";

  const unsubscribe = client.addEventListener((evt) => {
    const payload = evt.payload as
      | {
          runId?: string;
          sessionKey?: string;
          stream?: string;
          state?: string;
          deltaText?: string;
          replace?: boolean;
          data?: {
            delta?: string;
            text?: string;
            replace?: boolean;
            phase?: string;
            name?: string;
            toolCallId?: string;
            args?: unknown;
          };
          message?: { content?: Array<{ type?: string; text?: string }> };
        }
      | undefined;
    if (!payload) return;
    // Filter by sessionKey, not runId: OpenClaw's tool/lifecycle/assistant
    // events carry the *engine* runId, which is distinct from the
    // idempotencyKey we pass in chat.send. Per the OpenClaw web UI
    // (`ui/src/ui/app-tool-stream.ts`), session is the only reliable key.
    // Runs are serialized per session, so only one turn is in flight here.
    if (payload.sessionKey && payload.sessionKey !== input.sessionKey) return;

    if (!firstEventSeen) {
      firstEventSeen = true;
      perf?.mark("gw_first_event");
    }

    if (evt.event === "agent" && payload.stream === "tool") {
      const d = payload.data ?? {};
      const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : "";
      if (!toolCallId) return;
      const phase = d.phase === "start" || d.phase === "update" || d.phase === "result"
        ? d.phase
        : null;
      if (!phase) return;
      const name = typeof d.name === "string" ? d.name : "tool";
      const label = phase === "start" ? labelForTool(name, d.args) : undefined;
      events.push({ kind: "tool", phase, toolCallId, name, label });
      wake();
      return;
    }

    if (evt.event === "agent" && payload.stream === "lifecycle") {
      const d = payload.data ?? {};
      const phase = typeof d.phase === "string" ? d.phase : payload.state;
      if (phase) {
        events.push({ kind: "lifecycle", phase });
        wake();
      }
      return;
    }

    if (evt.event === "agent" && payload.stream === "assistant") {
      const d = payload.data ?? {};
      if (d.replace === true && typeof d.text === "string") {
        agentAssistantBuffer = d.text;
      } else if (typeof d.delta === "string") {
        agentAssistantBuffer = agentAssistantBuffer + d.delta;
      } else if (typeof d.text === "string" && d.text.length > agentAssistantBuffer.length) {
        agentAssistantBuffer = d.text;
      }
      emitMergedText(agentAssistantBuffer);
      return;
    }

    if (evt.event !== "chat") return;

    const merged = extractText(payload.message?.content);
    emitMergedText(merged);

    if (payload.state === "final" || payload.state === "complete") {
      perf?.mark("gw_final");
      // If nothing was streamed (deltaless provider AND empty final.message),
      // fall back to chat.history to pull the persisted assistant reply so
      // the user actually sees the text.
      if (lastEmittedLen === 0) {
        fetchHistoryFallback(client, input.sessionKey, turnStartedAt)
          .then((text) => {
            if (text && text.length > 0) emitMergedText(text);
          })
          .catch(() => {})
          .finally(() => {
            events.push({ kind: "final", text: merged });
            done = true;
            wake();
          });
      } else {
        events.push({ kind: "final", text: merged });
        done = true;
        wake();
      }
    }
  });

  // Wire abort: best-effort chat.abort + bail out.
  const onAbort = () => {
    void client.request("chat.abort", { sessionKey: input.sessionKey, runId }).catch(() => {});
    done = true;
    wake();
  };
  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // Fire the request. The promise resolves quickly with the runId-or-ack
    // payload; streaming text arrives as events.
    perf?.mark("gw_chat_send_start");
    void client
      .request("chat.send", {
        sessionKey: input.sessionKey,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        message: input.message,
        deliver: false,
        idempotencyKey: runId,
      })
      .then(() => {
        perf?.mark("gw_chat_send_ack");
      })
      .catch((err: Error) => {
        events.push({ kind: "error", message: err.message });
        done = true;
        wake();
      });

    while (!done || events.length > 0) {
      while (events.length > 0) {
        yield events.shift()!;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
        // Safety: time-bounded wait so we never hang forever if events stop.
        setTimeout(() => {
          if (resolveWait === resolve) {
            resolveWait = null;
            resolve();
          }
        }, 30_000);
      });
    }
  } finally {
    unsubscribe();
    if (input.signal) input.signal.removeEventListener("abort", onAbort);
    // Do NOT close the shared client — subsequent turns reuse it.
  }
}

/**
 * Compress a tool invocation's args into a single human-readable label.
 * Matches the spirit of OpenClaw's menu-bar status text (`exec: pnpm test`,
 * `read: apps/foo.ts`) so the chat UI feels familiar to anyone who's seen
 * the desktop app. Falls back to the bare tool name when nothing useful
 * can be extracted.
 */
function labelForTool(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  // exec / shell: show the first line of the command
  const cmd = pickString(a, ["command", "cmd", "script"]);
  if (cmd) return firstLine(cmd);
  // file ops: show the path
  const path = pickString(a, ["path", "file_path", "filename", "file"]);
  if (path) return shortenPath(path);
  // web fetches: show the URL
  const url = pickString(a, ["url", "uri"]);
  if (url) return url;
  // MCP / generic: show a method or query if present
  const method = pickString(a, ["method", "tool", "operation"]);
  if (method) return method;
  const query = pickString(a, ["query", "q", "prompt"]);
  if (query) return truncate(query, 120);
  // Last resort: stringify the args (capped) so the user sees *something*.
  try {
    const json = JSON.stringify(a);
    return truncate(json, 120);
  } catch {
    return undefined;
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  const line = nl >= 0 ? s.slice(0, nl) : s;
  return truncate(line, 160);
}

function shortenPath(p: string): string {
  // Keep filename + one parent dir to stay informative without taking up
  // a whole row — matches the menu-bar app's heuristic.
  const segs = p.split("/");
  if (segs.length <= 2) return p;
  return `…/${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function extractText(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/**
 * On terminal `chat` events with empty content (codex and other deltaless
 * providers), the assistant reply lives only in the persisted transcript.
 * The OpenClaw web UI handles this by calling `chat.history` after the final
 * event, and so do we — but transcript persistence happens asynchronously,
 * milliseconds after the final event fires, so a naive call returns the
 * previous turn's reply. Retry briefly until we see an assistant message
 * whose timestamp is at or after `notBefore` (the moment we sent the turn).
 *
 * Returns "" if no fresh assistant message appears within the retry budget.
 */
async function fetchHistoryFallback(
  client: GatewayClient,
  sessionKey: string,
  notBefore: number,
): Promise<string> {
  type HistoryMessage = {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    text?: string;
    timestamp?: number;
  };
  type HistoryResponse = { messages?: HistoryMessage[] };

  const findLatestAssistant = (msgs: HistoryMessage[]) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      const text = extractText(m.content) || (typeof m.text === "string" ? m.text : "");
      if (!text.trim()) continue;
      return { text, timestamp: typeof m.timestamp === "number" ? m.timestamp : 0 };
    }
    return null;
  };

  const MAX_ATTEMPTS = 8;
  const DELAY_MS = 80;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = (await client.request("chat.history", {
        sessionKey,
        limit: 8,
      })) as HistoryResponse | undefined;
      const msgs = Array.isArray(res?.messages) ? res!.messages : [];
      const hit = findLatestAssistant(msgs);
      if (hit && hit.timestamp >= notBefore) return hit.text;
    } catch {
      // swallow and retry
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return "";
}
