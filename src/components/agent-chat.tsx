"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Send,
  AlertCircle,
  StopCircle,
  Loader2,
  CheckCircle2,
  Terminal,
  FileText,
  Edit3,
  Globe,
  Wrench,
  ListChecks,
  MessageSquare,
  HelpCircle,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { stripOrchestrationBlocks } from "@/server/orchestration/blocks";
import {
  filterSlashCommands,
  executeLocalSlashCommand,
  parseSlashMessage,
  type SlashCommand,
} from "@/lib/slash-commands";
import { SlashCommandPopover } from "./slash-command-popover";
import { Markdown } from "./markdown";

type Step = {
  /** Stable per-invocation id from OpenClaw, used to update in-place. */
  toolCallId: string;
  /** Raw tool name (e.g. "exec", "read", "edit", "mcp:foo.bar"). */
  name: string;
  /** Pre-formatted one-liner from the server (command / path / etc.). */
  label?: string;
  /** start | update | result — drives the spinner vs check icon. */
  phase: "start" | "update" | "result";
};

type OrchestrationOutcome = {
  tasks_created: Array<{ id: string; title: string | null; assignee: string; status: string }>;
  task_status_updates: Array<{ task_id: string; status: string }>;
  comments_added: Array<{ task_id: string }>;
  ask_user: Array<{ task_id?: string; question: string }>;
  approvals_requested: Array<{ approval_id: string; action_type: string }>;
  errors: Array<{ kind: string; message: string }>;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "error";
  body: string;
  /**
   * Tool/MCP invocations the agent made before/while producing this reply,
   * surfaced inline so the user can watch what's happening instead of
   * staring at "thinking…". Empty on user/error rows.
   */
  steps?: Step[];
  /**
   * Structured orchestration outcome the server extracted from the
   * assistant's reply (tasks created, status updates, etc.). Rendered as
   * a small summary card below the assistant text. Stripped from the
   * Markdown body so the user doesn't see raw <create_task> tags.
   */
  orchestration?: OrchestrationOutcome;
};

export type InitialMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
};

/**
 * Module-level dedup for the auto-kickoff. Keyed by sessionId so different
 * threads kick off independently, but a single thread's StrictMode-induced
 * double-mount only fires once.
 */
const KICKOFF_FIRED = new Set<string>();

type Props = {
  projectSlug: string;
  agentSlug: string;
  agentDisplayName: string;
  sessionId: string;
  /**
   * OpenClaw's canonical `agent:<agent>:<label>` key for this thread. For
   * existing threads, label might be `main` (not the sessionId UUID), so we
   * thread the resolved key through instead of reconstructing it server-side.
   */
  sessionKey: string;
  /**
   * Template key the agent was provisioned from (e.g. "google_ads"). Kept
   * for future per-template chat affordances; currently unused.
   */
  templateKey?: string;
  initialMessages?: InitialMessage[];
  /**
   * When true, the chat auto-sends a hidden kickoff on mount so the agent
   * produces its first turn without the user needing to type. Used after
   * onboarding when FIRST_TURN.md is sitting in the agent workspace and
   * the agent system prompt is set up to read it and greet (D19), and on
   * /tasks/[id] when the task's per-task thread is opened for the first
   * time and the brief is delivered via the kickoff message.
   */
  autoKickoff?: boolean;
  /**
   * Override the default "(session start)" kickoff message. Used to
   * deliver per-task briefs to a specialist on first open of a task's
   * thread: the brief itself goes through the chat as a hidden message
   * so the agent has the full PRD before its first reply. Ignored unless
   * autoKickoff is also true.
   */
  kickoffMessage?: string;
};

export function AgentChat({
  projectSlug: _projectSlug,
  agentSlug,
  agentDisplayName,
  sessionId,
  sessionKey,
  templateKey: _templateKey,
  initialMessages = [],
  autoKickoff = false,
  kickoffMessage,
}: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Slash command autocomplete shows when the user's input starts with `/`
  // and has not yet been broken by a space (i.e., they're still composing the
  // command name, not its argument).
  const slashQuery = input.startsWith("/") && !input.includes(" ") ? input : null;
  const slashOpen = slashQuery !== null && !pending;
  const slashMatches = useMemo<SlashCommand[]>(
    () => (slashOpen ? filterSlashCommands(slashQuery!) : []),
    [slashOpen, slashQuery],
  );
  const safeSlashIndex = slashMatches.length === 0
    ? 0
    : Math.min(slashIndex, slashMatches.length - 1);

  function insertSlashCommand(cmd: SlashCommand) {
    // Catalog `name` is the command without the leading slash ("new", "clear").
    // Inserts must include it so the textarea ends up with "/new " — otherwise
    // the next Enter sends the bare word to the agent.
    const insert = cmd.insert ?? `/${cmd.name} `;
    setInput(insert);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(insert.length, insert.length);
        autoResize(ta);
      }
    });
  }

  // Auto-kickoff: on a brand-new thread when the server told us FIRST_TURN.md
  // is pending in the agent workspace, send a hidden first message so the
  // agent runs and produces its greeting (per D19). Dedup via a MODULE-level
  // Set keyed by sessionId — useRef doesn't survive React StrictMode dev
  // remounts (refs are reinitialized on every mount), so a ref guard fires
  // twice and triggers two concurrent chat requests, which can race the
  // gateway-client's connect handshake. The module-level set survives
  // remounts because the module isn't re-evaluated.
  useEffect(() => {
    if (!autoKickoff) return;
    if (KICKOFF_FIRED.has(sessionId)) return;
    if (messages.length > 0) return;
    if (pending) return;
    KICKOFF_FIRED.add(sessionId);
    // Hidden kickoff — the agent's system prompt routes from here. Default
    // is "(session start)" which trips FIRST_TURN.md handling; for task
    // threads the caller passes a kickoffMessage carrying the task brief.
    send(kickoffMessage ?? "(session start)", { hidden: true });
    // Intentionally do not depend on `send` (stable enough across renders) or
    // `messages` (would re-fire as the greeting streams in).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKickoff, sessionId]);

  // Keep the message thread pinned to the bottom on send / streaming updates.
  // Use the scroll container directly (not scrollIntoView on a sentinel) so we
  // don't accidentally scroll the whole page if the chat is nested.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // Auto-grow the textarea up to a cap so long composer drafts don't crowd
  // the message thread.
  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  async function send(
    overrideText?: string,
    opts: { hidden?: boolean } = {},
  ) {
    // overrideText: bypass the composer and send a programmatic message
    // (e.g., the MCP connect kickoff, or the FIRST_TURN.md auto-kickoff).
    // When provided, we do NOT touch the input/textarea state so the user's
    // draft is preserved.
    // opts.hidden: don't render the user bubble in the chat — used for the
    // FIRST_TURN.md kickoff where the user shouldn't see "Hi" land before
    // the agent's greeting.
    const usingOverride = typeof overrideText === "string";
    const text = (usingOverride ? overrideText : input).trim();
    if (!text || pending) return;

    // Local-only slash commands (clear, new, stop, help) — mirror OpenClaw web
    // UI behavior: handle client-side, do NOT send to the agent. Skip when
    // sending programmatically: overrides are always plain prompts.
    const parsed = usingOverride ? null : parseSlashMessage(text);
    if (parsed) {
      const action = executeLocalSlashCommand(parsed.command);
      if (action) {
        setInput("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        switch (action.kind) {
          case "clear":
            setMessages([]);
            return;
          case "new-session": {
            // Mint a fresh UUID and navigate — the new threaded URL becomes
            // the source of truth, no cookie roundtrip needed.
            const newId = crypto.randomUUID();
            startTransition(() => {
              router.push(`/agents/${agentSlug}/chat/${newId}`);
            });
            return;
          }
          case "stop":
            if (abortRef.current) abortRef.current.abort();
            return;
          case "help": {
            const helpId = `a-${Date.now()}`;
            setMessages((m) => [
              ...m,
              { id: `u-${Date.now()}`, role: "user", body: text },
              { id: helpId, role: "assistant", body: action.content },
            ]);
            return;
          }
        }
      }
    }

    const userMessage: Message = { id: `u-${Date.now()}`, role: "user", body: text };
    const assistantId = `a-${Date.now()}`;
    if (opts.hidden) {
      // Send the user message to the agent but suppress the bubble — only
      // the assistant placeholder appears, so the chat opens with the
      // greeting and not a synthetic user line.
      setMessages((m) => [...m, { id: assistantId, role: "assistant", body: "" }]);
    } else {
      setMessages((m) => [...m, userMessage, { id: assistantId, role: "assistant", body: "" }]);
    }
    if (!usingOverride) {
      setInput("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
    setPending(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const perf = makeClientPerf();
    perf.mark("send_click");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, agent: agentSlug, sessionId, sessionKey }),
        signal: ctrl.signal,
      });
      perf.mark("fetch_headers");
      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedText = false;
      let firstByteSeen = false;
      let firstTextSeen = false;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!firstByteSeen) {
          firstByteSeen = true;
          perf.mark("first_sse_byte");
        }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const raw of events) {
          const lines = raw.split("\n");
          const evtLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!evtLine || !dataLine) continue;
          const evt = evtLine.slice("event: ".length);
          let data: unknown;
          try {
            data = JSON.parse(dataLine.slice("data: ".length));
          } catch {
            continue;
          }
          if (evt === "text") {
            const chunk = (data as { chunk: string }).chunk;
            if (chunk.length > 0) receivedText = true;
            if (!firstTextSeen && chunk.length > 0) {
              firstTextSeen = true;
              perf.mark("first_text_chunk");
            }
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, body: msg.body + chunk } : msg,
              ),
            );
          } else if (evt === "tool") {
            // Live tool/MCP invocation. Update in place by toolCallId so a
            // start→result pair becomes one row that flips from spinner to
            // check, rather than two separate rows.
            const d = data as {
              phase: "start" | "update" | "result";
              tool_call_id: string;
              name: string;
              label?: string;
            };
            // Treat the first tool event as "we have visible progress" so the
            // empty-reply branch below doesn't blow away the step list with
            // the "(command handled by OpenClaw, no reply)" placeholder.
            receivedText = true;
            setMessages((m) =>
              m.map((msg) => {
                if (msg.id !== assistantId) return msg;
                const existing = msg.steps ?? [];
                const idx = existing.findIndex((s) => s.toolCallId === d.tool_call_id);
                if (idx < 0) {
                  return {
                    ...msg,
                    steps: [
                      ...existing,
                      {
                        toolCallId: d.tool_call_id,
                        name: d.name,
                        label: d.label,
                        phase: d.phase,
                      },
                    ],
                  };
                }
                const next = existing.slice();
                next[idx] = {
                  ...next[idx],
                  name: d.name,
                  // Label only arrives on "start"; preserve it on update/result.
                  label: d.label ?? next[idx].label,
                  phase: d.phase,
                };
                return { ...msg, steps: next };
              }),
            );
          } else if (evt === "lifecycle") {
            // Lifecycle markers (start/end/error) don't render today — the
            // spinner on the assistant bubble already conveys "in progress"
            // and the closing of the SSE stream marks the end. Reserved for
            // future use (e.g. compaction toasts) so we accept-and-ignore
            // rather than logging an "unknown event" warning.
          } else if (evt === "perf") {
            perf.recordServer(
              (data as { marks: Array<{ name: string; at: number; delta: number }> })
                .marks,
            );
          } else if (evt === "error") {
            const msg = (data as { message: string }).message;
            receivedText = true;
            setMessages((m) =>
              m.map((m2) =>
                m2.id === assistantId
                  ? { ...m2, role: "error", body: formatAgentError(msg) }
                  : m2,
              ),
            );
            toast.error(formatAgentError(msg));
          } else if (evt === "orchestration") {
            // Server extracted orchestration blocks from the agent's reply
            // and turned them into DB rows. Attach the outcome to this
            // assistant message so the UI can render a summary card below
            // the prose ("Created 3 tasks · View tasks →").
            const outcome = data as OrchestrationOutcome;
            setMessages((m) =>
              m.map((m2) =>
                m2.id === assistantId ? { ...m2, orchestration: outcome } : m2,
              ),
            );
            // Toast tasks_created so the user notices even if they're not
            // looking at the chat surface right now.
            if (outcome.tasks_created.length > 0) {
              toast.success(
                `Created ${outcome.tasks_created.length} task${outcome.tasks_created.length === 1 ? "" : "s"} for the specialist.`,
              );
              // Force the /tasks route to refetch since it's a server component
              // and won't auto-update otherwise.
              startTransition(() => router.refresh());
            }
          }
        }
      }
      perf.mark("stream_done");
      perf.report();

      // Slash commands forwarded to OpenClaw (compact, model, think, etc.)
      // sometimes complete with zero stdout. Leave a quiet acknowledgement so
      // the bubble doesn't sit on "thinking…" forever.
      if (!receivedText) {
        setMessages((m) =>
          m.map((m2) =>
            m2.id === assistantId
              ? { ...m2, body: "(command handled by OpenClaw, no reply)" }
              : m2,
          ),
        );
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (isAbort) {
        setMessages((m) =>
          m.map((m2) =>
            m2.id === assistantId
              ? { ...m2, body: (m2.body || "") + "\n\n(stopped)" }
              : m2,
          ),
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((m) =>
          m.map((m2) =>
            m2.id === assistantId
              ? { ...m2, role: "error", body: formatAgentError(msg) }
              : m2,
          ),
        );
        toast.error(formatAgentError(msg));
      }
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Slash autocomplete: while the popover is open, Tab AND Enter both insert
    // the highlighted match. After insert the textarea ends in a space, which
    // closes the popover — a second Enter then submits the input as usual.
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
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
        setSlashIndex(0);
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Scrollable message thread */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-live="polite"
      >
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          {messages.length === 0 ? (
            <EmptyState agentDisplayName={agentDisplayName} />
          ) : (
            <div className="space-y-6">
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  agentDisplayName={agentDisplayName}
                />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer — sits below the scroll area, full width with centered content */}
      <div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="relative mx-auto w-full max-w-3xl px-6 py-4">
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
              className="flex min-h-[44px] flex-1 resize-none rounded-2xl border bg-background px-4 py-2.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={`Message ${agentDisplayName}…  (type / for commands)`}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSlashIndex(0);
                autoResize(e.target);
              }}
              onKeyDown={onKey}
              disabled={pending}
              rows={1}
            />
            {pending ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => abortRef.current?.abort()}
                className="h-11 rounded-2xl"
              >
                <StopCircle className="size-4" />
                <span className="sr-only">Stop</span>
              </Button>
            ) : (
              <Button type="submit" className="h-11 rounded-2xl">
                <Send className="size-4" />
                <span className="sr-only">Send</span>
              </Button>
            )}
          </form>
        </div>
        <p className="pb-3 text-center text-[10px] text-muted-foreground">
          Enter to send · Shift+Enter for newline · / for slash commands
        </p>
      </div>
    </div>
  );
}

function EmptyState({ agentDisplayName }: { agentDisplayName: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="space-y-2">
        <h2 className="text-lg font-medium text-foreground">
          Talk to {agentDisplayName}
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          History persists per thread. Switch threads from the dropdown above.
        </p>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  agentDisplayName,
}: {
  message: Message;
  agentDisplayName: string;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
          {message.body}
        </div>
      </div>
    );
  }
  if (message.role === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-destructive">
            Couldn&rsquo;t reach {agentDisplayName}.
          </div>
          <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {message.body}
          </div>
        </div>
      </div>
    );
  }
  // Assistant: rendered as markdown for code blocks, lists, bold, tables, etc.
  // Plain text falls through unchanged because markdown is a superset. While
  // streaming, partial markdown (e.g. an unclosed fence) is rendered as far as
  // remark can parse it — visually fine because the next chunk arrives within
  // milliseconds. Orchestration blocks (<create_task> etc.) are stripped before
  // rendering so the user sees clean prose, not raw tags.
  const hasSteps = (message.steps?.length ?? 0) > 0;
  // Strip orchestration tags as text streams in — during streaming partially-
  // received tags briefly render then disappear once their closing tag arrives.
  const cleanBody = stripOrchestrationBlocks(message.body);
  const isEmpty = cleanBody === "";
  return (
    <div className="group space-y-2">
      {hasSteps && <StepList steps={message.steps!} />}
      {isEmpty ? (
        !hasSteps && (
          <div className="text-sm italic text-muted-foreground">
            {`${agentDisplayName} is thinking…`}
          </div>
        )
      ) : (
        <Markdown>{cleanBody}</Markdown>
      )}
      {message.orchestration && <OrchestrationSummary outcome={message.orchestration} />}
    </div>
  );
}

function OrchestrationSummary({ outcome }: { outcome: OrchestrationOutcome }) {
  const items: React.ReactNode[] = [];
  if (outcome.tasks_created.length > 0) {
    items.push(
      <div key="tasks" className="flex items-start gap-2 text-xs">
        <ListChecks className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            Created {outcome.tasks_created.length} task
            {outcome.tasks_created.length === 1 ? "" : "s"}
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {outcome.tasks_created.map((t) => (
              <li key={t.id} className="text-muted-foreground">
                <Link
                  href={`/tasks/${t.id}`}
                  className="hover:text-foreground hover:underline"
                >
                  {t.title ?? t.id.slice(0, 8)}
                </Link>{" "}
                <span className="text-[10px] tabular-nums">→ {t.assignee}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>,
    );
  }
  if (outcome.task_status_updates.length > 0) {
    items.push(
      <div key="status" className="flex items-start gap-2 text-xs">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
        <div>
          <div className="font-medium text-foreground">
            Updated {outcome.task_status_updates.length} task status
            {outcome.task_status_updates.length === 1 ? "" : "es"}
          </div>
          <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
            {outcome.task_status_updates.map((u) => (
              <li key={u.task_id}>
                <Link
                  href={`/tasks/${u.task_id}`}
                  className="hover:text-foreground hover:underline"
                >
                  {u.task_id.slice(0, 8)}
                </Link>{" "}
                → {u.status}
              </li>
            ))}
          </ul>
        </div>
      </div>,
    );
  }
  if (outcome.comments_added.length > 0) {
    items.push(
      <div key="comments" className="flex items-start gap-2 text-xs text-muted-foreground">
        <MessageSquare className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <div>
          Posted {outcome.comments_added.length} comment
          {outcome.comments_added.length === 1 ? "" : "s"} on existing task
          {outcome.comments_added.length === 1 ? "" : "s"}.
        </div>
      </div>,
    );
  }
  if (outcome.ask_user.length > 0) {
    items.push(
      <div key="ask" className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <div>
          {outcome.ask_user.length === 1
            ? "Waiting on your answer"
            : `Waiting on your answer on ${outcome.ask_user.length} questions`}{" "}
          — view in /activity.
        </div>
      </div>,
    );
  }
  if (outcome.approvals_requested.length > 0) {
    items.push(
      <div key="approval" className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <Shield className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <div>
          Requested {outcome.approvals_requested.length} approval
          {outcome.approvals_requested.length === 1 ? "" : "s"} —{" "}
          <Link href="/approvals" className="hover:text-foreground hover:underline">
            review in /approvals
          </Link>
          .
        </div>
      </div>,
    );
  }
  if (outcome.errors.length > 0) {
    items.push(
      <div key="errors" className="flex items-start gap-2 text-xs text-destructive">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <div>
          {outcome.errors.length} orchestration block{outcome.errors.length === 1 ? "" : "s"} failed to apply.
        </div>
      </div>,
    );
  }
  if (items.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2.5">{items}</div>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2">
      {steps.map((s) => (
        <StepRow key={s.toolCallId} step={s} />
      ))}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const Icon = iconForTool(step.name);
  const done = step.phase === "result";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {done ? (
          <CheckCircle2 className="size-3.5 text-emerald-600" />
        ) : (
          <Loader2 className="size-3.5 animate-spin" />
        )}
      </span>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[11px] font-medium text-foreground">
        {step.name}
      </span>
      {step.label && (
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {step.label}
        </span>
      )}
    </div>
  );
}

function iconForTool(name: string) {
  // Match icons to OpenClaw's built-in tool kinds. Anything else (MCP tools,
  // plugin tools) falls through to the generic Wrench icon.
  const n = name.toLowerCase();
  if (n === "exec" || n === "shell" || n.includes("bash")) return Terminal;
  if (n === "read" || n === "cat" || n === "open") return FileText;
  if (n === "write" || n === "edit" || n === "patch") return Edit3;
  if (n === "fetch" || n.includes("http") || n.includes("web")) return Globe;
  return Wrench;
}

function formatAgentError(raw: string): string {
  if (raw.includes("missing scope")) {
    return `${raw}\n\nHint: this OpenClaw slash command requires a permission your gateway token does not grant. Use the “New thread” button above for new conversations.`;
  }
  return raw;
}

/**
 * Client-side chat profiler. Records ms-offsets from send-click. At the end
 * of a turn `report()` prints a single `console.table` with both client marks
 * and the merged server timeline so a developer can attribute slow turns to
 * a stage (network, gateway open, model first-token, etc.) without leaving
 * DevTools. Disable via `localStorage.setItem("notfair.chat.perf", "0")`.
 */
function makeClientPerf() {
  const enabled =
    typeof window === "undefined"
      ? false
      : window.localStorage.getItem("notfair.chat.perf") !== "0";
  const start = performance.now();
  const marks: Array<{ name: string; at: number; delta: number }> = [];
  let lastAt = start;
  let serverMarks: Array<{ name: string; at: number; delta: number }> = [];
  const mark = (name: string) => {
    if (!enabled) return;
    const now = performance.now();
    const at = now - start;
    const delta = now - lastAt;
    lastAt = now;
    marks.push({ name, at, delta });
  };
  const recordServer = (s: Array<{ name: string; at: number; delta: number }>) => {
    serverMarks = s;
  };
  const report = () => {
    if (!enabled) return;
    // eslint-disable-next-line no-console
    console.group("[chat-perf] turn complete");
    // eslint-disable-next-line no-console
    console.table(
      marks.map((m) => ({
        stage: `client:${m.name}`,
        "+from start (ms)": Number(m.at.toFixed(1)),
        "Δ from prev (ms)": Number(m.delta.toFixed(1)),
      })),
    );
    if (serverMarks.length > 0) {
      // eslint-disable-next-line no-console
      console.table(
        serverMarks.map((m) => ({
          stage: `server:${m.name}`,
          "+from start (ms)": Number(m.at.toFixed(1)),
          "Δ from prev (ms)": Number(m.delta.toFixed(1)),
        })),
      );
    }
    // eslint-disable-next-line no-console
    console.groupEnd();
  };
  return { mark, recordServer, report };
}
