"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { findOpenTurn, isOpenTurnLive } from "@/lib/turn-state";
import type { TranscriptEvent } from "@/server/sessions/transcript-tail";
import {
  handleSseEvent,
  upsertToolEntry,
  type ToolEntry,
} from "./transcript-model";

const POLL_INTERVAL_MS = 2_000;

/**
 * The chat's streaming state machine, extracted whole from the original
 * LiveTranscript. Owns: the committed event log (poll + SSE-bridge fed,
 * deduped by durable event id), the optimistic pending state for an active
 * send, the send/stop calls, and the remote-turn detection that keeps
 * the UI honest about turns this tab didn't start.
 *
 * Deliberately contains NO rendering and NO slash-command logic — the
 * orchestrator intercepts slash commands before calling `send`.
 */
export function useChatStream({
  projectSlug,
  agentSlug,
  threadId,
  initialEvents,
  initialCursor,
  model,
  reasoningEffort,
}: {
  projectSlug: string;
  agentSlug: string;
  threadId: string;
  initialEvents: TranscriptEvent[];
  initialCursor: number;
  /** Composer model override value ("" = harness default). */
  model: string;
  /** Composer effort override value ("" = harness default). */
  reasoningEffort: string;
}) {
  const [events, setEvents] = useState<TranscriptEvent[]>(initialEvents);
  const [cursor, setCursor] = useState(initialCursor);
  const [sendingChat, setSendingChat] = useState(false);
  /**
   * Wallclock when the current turn started, in ms. Drives the "elapsed"
   * counter during the gap between hitting send and the agent's first
   * transcript event landing — without this, elapsed reflects the
   * *previous* turn's last event timestamp (often minutes/hours stale).
   */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);

  // Optimistic state for the active /api/chat send. Rendered after
  // committed events so the user sees their message + the streaming
  // response before polling materializes them from the DB. Cleared once
  // polling catches up.
  const [pendingUserMsg, setPendingUserMsg] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState("");
  const [pendingTools, setPendingTools] = useState<ToolEntry[]>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);
  /**
   * Most recent harness lifecycle phase for the in-flight turn (run.start,
   * run.warming, etc.). Surfaced in the "thinking…" indicator so a long
   * wait before the first model token at least shows forward motion.
   */
  const [pendingLifecycle, setPendingLifecycle] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // The stop click must reach the server: aborting the local fetch alone
  // never stops the harness turn (disconnect != cancel), so the transcript
  // would keep streaming the still-running reply via the poll.
  const stopTurn = useCallback(() => {
    abortRef.current?.abort();
    void fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: projectSlug,
        agent: agentSlug,
        thread: threadId,
      }),
    }).catch(() => {
      // Best-effort: the local abort already froze the composer's stream.
    });
  }, [agentSlug, projectSlug, threadId]);

  /**
   * Ids of every transcript event we've already committed to state. Acts as
   * a dedupe set for poll-result merging: two `pollOnce` calls can fire
   * with the same `cursor` closure before React commits the next offset
   * (e.g. the post-stream catch-up poll racing the background polling
   * effect), so both fetches would return the same event slice and we'd
   * end up with duplicate React keys. Lives in a ref so the dedupe is
   * synchronous — `setEvents(prev => …)` updater functions don't run
   * until React's next commit, so they can't be used to derive the count
   * we return from `pollOnce`.
   */
  const seenEventIdsRef = useRef<Set<string>>(
    new Set(initialEvents.map((e) => e.id)),
  );

  const commitFresh = useCallback((incoming: TranscriptEvent[]) => {
    const fresh = incoming.filter((e) => {
      if (seenEventIdsRef.current.has(e.id)) return false;
      return true;
    });
    for (const e of fresh) {
      seenEventIdsRef.current.add(e.id);
    }
    if (fresh.length > 0) {
      setEvents((prev) => [...prev, ...fresh]);
      // Clear pending state: the DB now has the canonical events so the
      // optimistic placeholders are no longer needed.
      setPendingUserMsg(null);
      setPendingAssistant("");
      setPendingTools([]);
      setPendingError(null);
      setPendingLifecycle(null);
    }
    return fresh.length;
  }, []);

  // ── Live tail polling. ─────────────────────────────────────────────
  const pollOnce = useCallback(async () => {
    try {
      // Pass projectSlug explicitly: the API route would otherwise fall back
      // to the active-project cookie, which can lag the URL on first paint
      // after a project switch or direct deep-link.
      const url = `/api/agents/${agentSlug}/threads/${threadId}/transcript?offset=${cursor}&project=${encodeURIComponent(projectSlug)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return { newEvents: 0 };
      const data = (await res.json()) as {
        events: TranscriptEvent[];
        cursor: number;
      };
      const newEvents = commitFresh(data.events);
      if (data.cursor !== cursor) setCursor(data.cursor);
      return { newEvents };
    } catch {
      return { newEvents: 0 };
    }
  }, [agentSlug, commitFresh, cursor, projectSlug, threadId]);

  // Poll faster only during an active send. A disabled composer can also
  // mean "read-only history," which should not be treated as live work.
  const pollIntervalMs = sendingChat ? 800 : POLL_INTERVAL_MS;

  // Background polling: runs while mounted, paused during an active send so
  // we don't double-render content we're already streaming via SSE.
  useEffect(() => {
    if (sendingChat) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await pollOnce();
      if (cancelled) return;
      timer = setTimeout(tick, pollIntervalMs);
    };
    timer = setTimeout(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollIntervalMs, pollOnce, sendingChat]);

  // ── Live re-attach: SSE bridge to committed transcript events. ──────
  // The DB poll can lag a fast-streaming turn, so polling sees nothing
  // mid-turn. Transcript inserts also emit the same durable row through
  // an in-process live stream, so a tab switching back to a thread sees
  // progress immediately instead of waiting for its next poll.
  //
  // The bridge runs on every thread mount, not just tasks. An idle thread
  // simply emits nothing. Polling and the live bridge carry the same row
  // id, so the synchronous id set prevents double-rendering.
  //
  // Skipped during an active /api/chat send — that path already streams
  // its own deltas; layering re-attach on top would just duplicate work.
  useEffect(() => {
    const log = (...args: unknown[]) => console.log("[live-bridge]", ...args);
    if (sendingChat) {
      log("skip: sendingChat=true (/api/chat path owns streaming)", { threadId });
      return;
    }
    if (typeof EventSource === "undefined") {
      log("skip: no EventSource in env (jsdom test)");
      return;
    }
    const url = `/api/agents/${agentSlug}/threads/${threadId}/live?project=${encodeURIComponent(projectSlug)}`;
    log("opening", { url });
    const es = new EventSource(url);
    es.addEventListener("open", () => log("opened"));
    es.addEventListener("ready", (e: MessageEvent) => log("ready", e.data));
    es.addEventListener("transcript", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { events: TranscriptEvent[] };
        if (!Array.isArray(data.events)) {
          log("transcript payload not an array", data);
          return;
        }
        const fresh = commitFresh(data.events);
        log("transcript", { incoming: data.events.length, fresh });
      } catch (err) {
        log("transcript parse error", err);
      }
    });
    es.addEventListener("error", (e) => {
      log("error", { readyState: es.readyState, event: e });
    });
    return () => {
      log("closing", { threadId });
      es.close();
    };
  }, [agentSlug, commitFresh, projectSlug, sendingChat, threadId]);

  // ── Send: optimistic user message + SSE-driven streaming reply. ─────
  const send = useCallback(
    async (text: string, opts: { hidden?: boolean } = {}) => {
      if (!text || sendingChat) return;

      setSendingChat(true);
      setTurnStartedAt(Date.now());
      setPendingUserMsg(opts.hidden ? null : text);
      setPendingAssistant("");
      setPendingTools([]);
      setPendingError(null);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            agent: agentSlug,
            project: projectSlug,
            thread: threadId,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error((await res.text()) || `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const raw of chunks) {
            handleSseEvent(raw, {
              onText: (chunk) => setPendingAssistant((s) => s + chunk),
              onTool: (evt) =>
                setPendingTools((prev) => upsertToolEntry(prev, evt)),
              onError: (msg) => setPendingError(msg),
              onLifecycle: (phase) => setPendingLifecycle(phase),
              onMeta: (meta) => {
                if (process.env.NODE_ENV !== "production") {
                  // eslint-disable-next-line no-console
                  console.log(
                    `[chat-perf] turn start agent=${meta.agent} session=${meta.session_id} message_chars=${meta.message_chars}${meta.is_kickoff ? " (kickoff)" : ""}`,
                  );
                }
              },
              onPerf: (marks) => {
                if (process.env.NODE_ENV !== "production") {
                  // eslint-disable-next-line no-console
                  console.groupCollapsed(
                    `[chat-perf] turn complete (${marks.length} marks)`,
                  );
                  // eslint-disable-next-line no-console
                  console.table(
                    marks.map((m) => ({
                      name: m.name,
                      "at (ms)": Math.round(m.at),
                      "Δ (ms)": Math.round(m.delta),
                    })),
                  );
                  // eslint-disable-next-line no-console
                  console.groupEnd();
                }
              },
            });
          }
        }
        // Stream closed. Give the writer a moment to flush, then pull the
        // committed events. pollOnce clears pending state when it returns
        // new events; if it returns nothing yet, the regular polling
        // effect picks it up on the next tick.
        await new Promise((r) => setTimeout(r, 400));
        const { newEvents } = await pollOnce();
        if (newEvents === 0) {
          // Re-try once more shortly. Avoids the case where the writer is
          // slow to flush and the user briefly sees pending state with no
          // backing rows.
          setTimeout(() => {
            void pollOnce();
          }, 1200);
        }
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (!isAbort) {
          const msg = err instanceof Error ? err.message : String(err);
          setPendingError(msg);
          return { error: msg } as const;
        }
      } finally {
        setSendingChat(false);
        setTurnStartedAt(null);
        setPendingLifecycle(null);
        abortRef.current = null;
      }
      return { error: null } as const;
    },
    [agentSlug, model, pollOnce, projectSlug, reasoningEffort, sendingChat, threadId],
  );

  /** Local-view reset for the /clear slash command. */
  const clearLocal = useCallback(() => {
    setEvents([]);
    setCursor(0);
  }, []);

  // A turn can be running that THIS tab didn't start — another tab, a
  // reload mid-turn, or a dropped SSE stream (the backend keeps going;
  // disconnect ≠ cancel). Derive in-flight state from the committed
  // events, with a staleness cutoff so a server crash can't strand a
  // forever-spinner.
  const openTurn = useMemo(() => findOpenTurn(events), [events]);
  const [staleNow, setStaleNow] = useState(() => Date.now());
  useEffect(() => {
    if (!openTurn || sendingChat) return;
    setStaleNow(Date.now());
    const id = setInterval(() => setStaleNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [openTurn, sendingChat]);
  const remoteTurnActive = !sendingChat && isOpenTurnLive(openTurn, staleNow);

  return {
    events,
    sendingChat,
    turnStartedAt,
    openTurn,
    remoteTurnActive,
    pendingUserMsg,
    pendingAssistant,
    pendingTools,
    pendingError,
    pendingLifecycle,
    send,
    stopTurn,
    clearLocal,
  };
}
