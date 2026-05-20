"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Edit3,
  FileText,
  Globe,
  Loader2,
  Send,
  StopCircle,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { RunningDot } from "@/components/running-dot";
import { SlashCommandPopover } from "@/components/slash-command-popover";
import { cn } from "@/lib/utils";
import {
  executeLocalSlashCommand,
  filterSlashCommands,
  parseSlashMessage,
  type SlashCommand,
} from "@/lib/slash-commands";
import { stripOrchestrationBlocks } from "@/server/orchestration/blocks";
import type { TranscriptEvent } from "@/server/openclaw/transcript-tail";

const POLL_INTERVAL_MS = 2_000;

type Props = {
  agentSlug: string;
  agentDisplayName: string;
  /** OpenClaw thread (the URL label half of `agent:<agent>:<label>`). */
  threadId: string;
  /** Canonical sessionKey for /api/chat sends. */
  sessionKey: string;
  /** Server-rendered initial slice of the transcript. */
  initialEvents: TranscriptEvent[];
  /** Byte offset *after* `initialEvents` — polls start from here. */
  initialByteOffset: number;
  /**
   * When true, disables the composer (e.g., task is running and the user
   * shouldn't send mid-run input). Default: composer always enabled.
   */
  composerDisabled?: boolean;
  /**
   * When set, on each successful poll we call this so the parent can
   * react to JSONL growth (e.g., trigger router.refresh to refetch task
   * statuses). Returning true tells us to stop background polling.
   */
  onPolled?: (info: { newEvents: number; fileSize: number }) => boolean | void;
  /**
   * Auto-kickoff: when true AND the transcript is empty AND we're not
   * already sending, fire a hidden first message so the agent runs
   * without the user typing. Used by /chat after onboarding (the
   * FIRST_TURN.md sentinel) so the CMO greets without a manual nudge.
   */
  autoKickoff?: boolean;
  /** Override for the auto-kickoff message body. */
  kickoffMessage?: string;
};

/** Module-level guard so React StrictMode dev double-mounts don't double-fire. */
const KICKOFF_FIRED = new Set<string>();

export function LiveTranscript({
  agentSlug,
  agentDisplayName,
  threadId,
  sessionKey,
  initialEvents,
  initialByteOffset,
  composerDisabled = false,
  onPolled,
  autoKickoff = false,
  kickoffMessage,
}: Props) {
  const router = useRouter();
  const [events, setEvents] = useState<TranscriptEvent[]>(initialEvents);
  const [byteOffset, setByteOffset] = useState(initialByteOffset);
  const [input, setInput] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const [stopPolling, setStopPolling] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Slash command autocomplete: open while input starts with "/" and the
  // user is still composing the command name (no space yet). After they
  // pick or type a space, the popover closes.
  const slashQuery = input.startsWith("/") && !input.includes(" ") ? input : null;
  const slashOpen = slashQuery !== null && !sendingChat && !composerDisabled;
  const slashMatches = useMemo<SlashCommand[]>(
    () => (slashOpen ? filterSlashCommands(slashQuery!) : []),
    [slashOpen, slashQuery],
  );
  const safeSlashIndex =
    slashMatches.length === 0
      ? 0
      : Math.min(slashIndex, slashMatches.length - 1);

  function insertSlashCommand(cmd: SlashCommand) {
    // Catalog `name` is the command without the leading slash ("new", "clear").
    // Insert ends with a trailing space so the popover closes — a second
    // Enter then submits.
    const insert = cmd.insert ?? `/${cmd.name} `;
    setInput(insert);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(insert.length, insert.length);
      }
    });
  }

  // Optimistic state for the active /api/chat send. Rendered after committed
  // events so the user sees their message + the streaming response before
  // polling materializes them from JSONL. Cleared once polling catches up.
  const [pendingUserMsg, setPendingUserMsg] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState("");
  const [pendingTools, setPendingTools] = useState<ToolEntry[]>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  // ── Auto-scroll: only when the user is already near the bottom. ─────
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickyBottomRef.current = remaining < 96;
  }
  useLayoutEffect(() => {
    if (!stickyBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, sendingChat, pendingAssistant, pendingTools, pendingUserMsg]);

  // ── Live tail polling. ─────────────────────────────────────────────
  const pollOnce = useCallback(async () => {
    try {
      const url = `/api/agents/${agentSlug}/threads/${threadId}/transcript?offset=${byteOffset}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return { newEvents: 0 };
      const data = (await res.json()) as {
        events: TranscriptEvent[];
        byteOffset: number;
        file_size: number;
      };
      if (data.events.length > 0) {
        setEvents((prev) => [...prev, ...data.events]);
        // Clear pending state: JSONL now has the canonical events so the
        // optimistic placeholders are no longer needed.
        setPendingUserMsg(null);
        setPendingAssistant("");
        setPendingTools([]);
        setPendingError(null);
      }
      if (data.byteOffset !== byteOffset) setByteOffset(data.byteOffset);
      const shouldStop = onPolled?.({
        newEvents: data.events.length,
        fileSize: data.file_size,
      });
      if (shouldStop) setStopPolling(true);
      return { newEvents: data.events.length };
    } catch {
      return { newEvents: 0 };
    }
  }, [agentSlug, byteOffset, onPolled, threadId]);

  // Poll faster while the parent says the task is in flight — typical
  // first-task experience is "land on workspace, watch the audit run."
  // 2s feels laggy when nothing's on screen; 800ms keeps the pulse fresh.
  const pollIntervalMs = composerDisabled ? 800 : POLL_INTERVAL_MS;

  // Background polling: runs while mounted, paused during an active send so
  // we don't double-render content we're already streaming via SSE.
  useEffect(() => {
    if (stopPolling) return;
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
  }, [pollIntervalMs, pollOnce, sendingChat, stopPolling]);

  // ── Send: optimistic user message + SSE-driven streaming reply. ─────
  const send = useCallback(
    async (overrideText?: string, opts: { hidden?: boolean } = {}) => {
      const usingOverride = typeof overrideText === "string";
      const text = (usingOverride ? overrideText : input).trim();
      if (!text || sendingChat) return;

      // Local slash commands intercept the send. Skip when the message
      // was sent programmatically (overrides are always real prompts).
      const parsed = usingOverride ? null : parseSlashMessage(text);
      if (parsed) {
        const action = executeLocalSlashCommand(parsed.command);
        if (action) {
          setInput("");
          switch (action.kind) {
            case "clear":
              setEvents([]);
              setByteOffset(0);
              toast.info(
                "Local view cleared. Full transcript is still on disk; the next agent reply will repopulate.",
              );
              return;
            case "new-session": {
              const newId = crypto.randomUUID();
              router.push(`/agents/${agentSlug}/chat/${newId}`);
              return;
            }
            case "stop":
              abortRef.current?.abort();
              return;
            case "help":
              toast.message("Slash commands", { description: action.content });
              return;
          }
        }
      }

      if (!usingOverride) setInput("");
      setSendingChat(true);
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
            sessionId: threadId,
            sessionKey,
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
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const raw of events) {
            handleSseEvent(raw, {
              onText: (chunk) => setPendingAssistant((s) => s + chunk),
              onTool: (evt) => {
                setPendingTools((prev) =>
                  upsertToolEntry(prev, evt),
                );
              },
              onError: (msg) => setPendingError(msg),
            });
          }
        }
        // Stream closed. Give OpenClaw a moment to flush the JSONL, then
        // pull the committed events. pollOnce clears pending state when it
        // returns new events; if it returns nothing yet, the regular
        // polling effect picks it up on the next tick.
        await new Promise((r) => setTimeout(r, 400));
        const { newEvents } = await pollOnce();
        if (newEvents === 0) {
          // Re-try once more shortly. Avoids the case where OpenClaw is
          // slow to flush and the user briefly sees pending state with no
          // backing JSONL.
          setTimeout(() => {
            void pollOnce();
          }, 1200);
        }
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (!isAbort) {
          const msg = err instanceof Error ? err.message : String(err);
          setPendingError(msg);
          toast.error(msg);
        }
      } finally {
        setSendingChat(false);
        abortRef.current = null;
      }
    },
    [agentSlug, input, pollOnce, router, sendingChat, sessionKey, threadId],
  );

  // ── Auto-kickoff for FIRST_TURN-style flows. ────────────────────────
  useEffect(() => {
    if (!autoKickoff) return;
    if (KICKOFF_FIRED.has(threadId)) return;
    if (events.length > 0) return;
    if (sendingChat) return;
    KICKOFF_FIRED.add(threadId);
    void send(kickoffMessage ?? "(session start)", { hidden: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKickoff, threadId]);

  const rendered = useMemo(() => collapseEvents(events), [events]);
  // Pulse the "thinking" indicator any time the agent could plausibly be
  // working: the user just sent (sendingChat) OR the parent told us this is
  // an in-flight task (composerDisabled) with no streaming output yet to
  // show. Without the second branch, server-side kickoffs land the user on
  // a silent page until the first poll picks up bytes — that's the "did my
  // task even get delivered?" gap the user flagged.
  const showThinking =
    pendingAssistant === "" &&
    pendingTools.length === 0 &&
    (sendingChat || composerDisabled);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-live="polite"
      >
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {rendered.length === 0 &&
          !pendingUserMsg &&
          !sendingChat &&
          !composerDisabled ? (
            <TranscriptEmptyState agentDisplayName={agentDisplayName} />
          ) : (
            <ol className="space-y-4">
              {rendered.map((item) => (
                <li key={item.key}>
                  <RenderItem item={item} />
                </li>
              ))}
              {pendingUserMsg && (
                <li>
                  <UserBubble body={pendingUserMsg} />
                </li>
              )}
              {pendingTools.length > 0 && (
                <li>
                  <ToolGroup tools={pendingTools} />
                </li>
              )}
              {pendingAssistant && (
                <li>
                  <AssistantText body={pendingAssistant} />
                </li>
              )}
              {pendingError && (
                <li>
                  <ErrorRow agentDisplayName={agentDisplayName} body={pendingError} />
                </li>
              )}
              {showThinking && (
                <li>
                  <ThinkingPulse agentDisplayName={agentDisplayName} />
                </li>
              )}
            </ol>
          )}
        </div>
      </div>

      <div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="relative mx-auto w-full max-w-3xl px-6 py-3">
          {slashOpen && (
            <SlashCommandPopover
              commands={slashMatches}
              selectedIndex={safeSlashIndex}
              onSelect={insertSlashCommand}
              onHover={setSlashIndex}
            />
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSlashIndex(0);
              }}
              onKeyDown={(e) => {
                // Slash autocomplete: arrow keys cycle, Tab/Enter insert.
                if (slashOpen && slashMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((i) => (i + 1) % slashMatches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex(
                      (i) =>
                        (i - 1 + slashMatches.length) % slashMatches.length,
                    );
                    return;
                  }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    const picked = slashMatches[safeSlashIndex];
                    if (picked) insertSlashCommand(picked);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setInput("");
                    setSlashIndex(0);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={composerDisabled}
              placeholder={
                composerDisabled
                  ? `${agentDisplayName} is on a task — the transcript updates live`
                  : `Message ${agentDisplayName}…  (type / for commands)`
              }
              rows={1}
              className="flex min-h-[40px] flex-1 resize-none rounded-xl border bg-background px-3.5 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
            {sendingChat ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => abortRef.current?.abort()}
                className="h-10 rounded-xl"
                aria-label="Stop"
              >
                <StopCircle className="size-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={composerDisabled || !input.trim()}
                className="h-10 rounded-xl"
                aria-label="Send"
              >
                <Send className="size-4" />
              </Button>
            )}
          </form>
          <p className="pt-1.5 text-center text-[10px] text-muted-foreground">
            {sendingChat ? (
              <span className="inline-flex items-center gap-1.5">
                <RunningDot size="sm" aria-label="" />
                Streaming — click stop to abort
              </span>
            ) : (
              <>Enter to send · Shift+Enter for newline</>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── SSE plumbing for the active send ────────────────────────────────────

type SseToolEvent = {
  phase: "start" | "update" | "result";
  tool_call_id: string;
  name: string;
  label?: string;
};

function handleSseEvent(
  raw: string,
  handlers: {
    onText: (chunk: string) => void;
    onTool: (evt: SseToolEvent) => void;
    onError: (msg: string) => void;
  },
) {
  const lines = raw.split("\n");
  const evtLine = lines.find((l) => l.startsWith("event: "));
  const dataLine = lines.find((l) => l.startsWith("data: "));
  if (!evtLine || !dataLine) return;
  const evt = evtLine.slice("event: ".length);
  let data: unknown;
  try {
    data = JSON.parse(dataLine.slice("data: ".length));
  } catch {
    return;
  }
  if (evt === "text") {
    const chunk = (data as { chunk?: string }).chunk;
    if (typeof chunk === "string") handlers.onText(chunk);
    return;
  }
  if (evt === "tool") {
    handlers.onTool(data as SseToolEvent);
    return;
  }
  if (evt === "error") {
    const msg = (data as { message?: string }).message ?? "unknown error";
    handlers.onError(msg);
    return;
  }
}

function upsertToolEntry(prev: ToolEntry[], evt: SseToolEvent): ToolEntry[] {
  const idx = prev.findIndex((t) => t.toolCallId === evt.tool_call_id);
  if (idx < 0) {
    return [
      ...prev,
      {
        toolCallId: evt.tool_call_id,
        name: evt.name,
        label: evt.label ?? null,
        result: null,
        ok: true,
        done: evt.phase === "result",
      },
    ];
  }
  const next = prev.slice();
  const existing = next[idx]!;
  next[idx] = {
    ...existing,
    name: evt.name,
    label: evt.label ?? existing.label,
    done: evt.phase === "result" ? true : existing.done,
  };
  return next;
}

// ── Rendering helpers ──────────────────────────────────────────────────

type ToolEntry = {
  toolCallId: string;
  name: string;
  label: string | null;
  result: string | null;
  ok: boolean;
  done: boolean;
};

type RenderedItem =
  | { kind: "user_message"; key: string; body: string }
  | { kind: "assistant_text"; key: string; body: string }
  | { kind: "tool_group"; key: string; tools: ToolEntry[] }
  | { kind: "system_unknown"; key: string; raw_type: string };

/**
 * The on-disk JSONL writes `toolCall` and `toolResult` as separate parts,
 * sometimes interleaved across multiple message rows in one turn. We:
 *   1. Pair calls with their later results by tool_call_id so each tool
 *      renders as one logical entry (spinner → check).
 *   2. Group runs of contiguous tool entries (no assistant_text or
 *      user_message between them) into a single collapsible "tool_group".
 *      Mirrors Claude.ai's pattern — one card per cluster, summary shows
 *      the most recent tool name, expand to see all of them.
 */
function collapseEvents(events: TranscriptEvent[]): RenderedItem[] {
  type Step =
    | { tag: "tool"; key: string; entry: ToolEntry }
    | { tag: "msg"; item: RenderedItem };
  const steps: Step[] = [];
  const callIndex = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "tool_call") {
      callIndex.set(e.tool_call_id, steps.length);
      steps.push({
        tag: "tool",
        key: e.id,
        entry: {
          toolCallId: e.tool_call_id,
          name: e.name,
          label: e.label,
          result: null,
          ok: true,
          done: false,
        },
      });
      continue;
    }
    if (e.kind === "tool_result") {
      const idx = callIndex.get(e.tool_call_id);
      const step = idx != null ? steps[idx] : null;
      if (step && step.tag === "tool") {
        step.entry = {
          ...step.entry,
          result: e.summary,
          ok: e.ok,
          done: true,
        };
        continue;
      }
      steps.push({
        tag: "tool",
        key: e.id,
        entry: {
          toolCallId: e.tool_call_id,
          name: e.name,
          label: null,
          result: e.summary,
          ok: e.ok,
          done: true,
        },
      });
      continue;
    }
    if (e.kind === "user_message") {
      steps.push({
        tag: "msg",
        item: { kind: "user_message", key: e.id, body: e.body },
      });
      continue;
    }
    if (e.kind === "assistant_text") {
      steps.push({
        tag: "msg",
        item: { kind: "assistant_text", key: e.id, body: e.body },
      });
      continue;
    }
    if (e.kind === "unknown") {
      steps.push({
        tag: "msg",
        item: { kind: "system_unknown", key: e.id, raw_type: e.raw_type },
      });
      continue;
    }
  }
  const out: RenderedItem[] = [];
  let buffer: ToolEntry[] = [];
  let bufferKey: string | null = null;
  const flush = () => {
    if (buffer.length === 0) return;
    out.push({ kind: "tool_group", key: `tg:${bufferKey}`, tools: buffer });
    buffer = [];
    bufferKey = null;
  };
  for (const step of steps) {
    if (step.tag === "tool") {
      if (bufferKey === null) bufferKey = step.key;
      buffer.push(step.entry);
    } else {
      flush();
      out.push(step.item);
    }
  }
  flush();
  return out;
}

function RenderItem({ item }: { item: RenderedItem }) {
  if (item.kind === "user_message") {
    const isKickoff =
      item.body.startsWith("(task assignment)") ||
      item.body.startsWith("(session start)") ||
      item.body.startsWith("TASK_BRIEF") ||
      item.body.startsWith("FIRST_TURN");
    if (isKickoff) return <KickoffBlock body={item.body} />;
    return <UserBubble body={item.body} />;
  }
  if (item.kind === "assistant_text") {
    return <AssistantText body={item.body} />;
  }
  if (item.kind === "tool_group") {
    return <ToolGroup tools={item.tools} />;
  }
  return null;
}

function UserBubble({ body }: { body: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
        {body}
      </div>
    </div>
  );
}

function AssistantText({ body }: { body: string }) {
  const cleanBody = stripOrchestrationBlocks(body);
  if (cleanBody.trim() === "") return null;
  return (
    <div className="text-sm leading-relaxed">
      <Markdown>{cleanBody}</Markdown>
    </div>
  );
}

function KickoffBlock({ body }: { body: string }) {
  // Open by default so the user sees the brief was actually delivered — the
  // moment the page loads, this is the only proof the agent received its
  // assignment. Users can collapse it once they've read it; the chevron
  // makes that affordance obvious.
  return (
    <details
      open
      className="group rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2 text-xs"
    >
      <summary className="flex cursor-pointer items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground select-none">
        <span aria-hidden className="transition-transform group-open:rotate-90">
          ›
        </span>
        Task brief sent to agent
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
        {body}
      </pre>
    </details>
  );
}

function ToolGroup({ tools }: { tools: ToolEntry[] }) {
  const inFlightCount = tools.filter((t) => !t.done).length;
  const isLive = inFlightCount > 0;
  const headline =
    tools.find((t) => !t.done) ?? tools[tools.length - 1] ?? null;
  // Group status reflects the FINAL outcome, not "any error ever". When the
  // agent retried a failed call and the retry succeeded, the user sees
  // green — only expanding the card reveals the intermediate stumble.
  // Matches Claude.ai's pattern of grading by "did this turn ultimately
  // work" rather than punishing every recoverable hiccup.
  const lastDone = [...tools].reverse().find((t) => t.done);
  const hasError = !!(lastDone && !lastDone.ok);
  const HeadIcon = headline ? iconForTool(headline.name) : Wrench;
  const StatusIcon = isLive
    ? Loader2
    : hasError
      ? AlertCircle
      : CheckCircle2;
  const statusClass = isLive
    ? "text-muted-foreground motion-safe:animate-spin"
    : hasError
      ? "text-destructive"
      : "text-emerald-600";

  return (
    <details
      key={isLive ? "live" : "done"}
      open={isLive}
      className="group rounded-md border bg-muted/20"
    >
      <summary
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs",
          "rounded-md hover:bg-muted/40 [&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <StatusIcon className={cn("size-3.5 shrink-0", statusClass)} />
        <HeadIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[11px] font-medium text-foreground">
          {headline ? headline.name : "tool"}
        </span>
        {headline?.label && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {headline.label}
          </span>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {isLive ? (
            <span className="inline-flex items-center gap-1.5">
              <RunningDot size="sm" aria-label="" />
              {tools.length === 1
                ? "running"
                : `${tools.length} steps · ${inFlightCount} live`}
            </span>
          ) : (
            <>
              {tools.length} step{tools.length === 1 ? "" : "s"}
            </>
          )}
        </span>
      </summary>
      <div className="space-y-1 border-t bg-background/40 px-3 py-2">
        {tools.map((t) => (
          <ToolRow key={t.toolCallId} entry={t} />
        ))}
      </div>
    </details>
  );
}

function ToolRow({ entry }: { entry: ToolEntry }) {
  const Icon = iconForTool(entry.name);
  const StatusIcon = entry.done
    ? entry.ok
      ? CheckCircle2
      : AlertCircle
    : Loader2;
  const statusClass = entry.done
    ? entry.ok
      ? "text-emerald-600"
      : "text-destructive"
    : "text-muted-foreground motion-safe:animate-spin";
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-xs">
        <StatusIcon className={cn("size-3.5 shrink-0", statusClass)} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[11px] font-medium text-foreground">
          {entry.name}
        </span>
        {entry.label && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {entry.label}
          </span>
        )}
      </div>
      {entry.done && entry.result && (
        <div className="pl-6 font-mono text-[11px] text-muted-foreground/90">
          <span className="text-[10px] uppercase tracking-[0.18em]">
            {entry.ok ? "→ result" : "→ error"}
          </span>{" "}
          <span className="break-words">{entry.result}</span>
        </div>
      )}
    </div>
  );
}

function ThinkingPulse({ agentDisplayName }: { agentDisplayName: string }) {
  return (
    <div className="flex items-center gap-2 text-xs italic text-muted-foreground">
      <RunningDot size="sm" aria-label="" />
      {agentDisplayName} is working…
    </div>
  );
}

function ErrorRow({
  agentDisplayName,
  body,
}: {
  agentDisplayName: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-destructive">
          Couldn&rsquo;t reach {agentDisplayName}.
        </div>
        <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {body}
        </div>
      </div>
    </div>
  );
}

function TranscriptEmptyState({
  agentDisplayName,
}: {
  agentDisplayName: string;
}) {
  return (
    <div className="py-12 text-center text-sm text-muted-foreground">
      No messages yet. Say hi to {agentDisplayName} below.
    </div>
  );
}

function iconForTool(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n === "exec" || n === "shell" || n === "bash" || n.includes("bash"))
    return Terminal;
  if (n === "read" || n === "cat" || n === "open" || n.includes("read"))
    return FileText;
  if (n === "write" || n === "edit" || n === "patch") return Edit3;
  if (n === "fetch" || n.includes("http") || n.includes("web")) return Globe;
  return Wrench;
}
