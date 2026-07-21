"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronRight, Layers, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  getGoalContextAction,
  type ContextChunk,
} from "@/server/actions/context";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";

/**
 * /context for a goal: what fills this agent's context window, measured
 * against the CURRENT chat model's real window size (read from the
 * harness's own model metadata — never hardcoded here). The current model
 * is whatever the composer would use: the per-project+agent localStorage
 * override when set, else the harness default. Token counts are estimates
 * (~4 chars/token); clicking a row reveals the chunk's exact content.
 */

export type ContextModelOption = {
  value: string;
  label: string;
  context_window?: number;
  is_default?: boolean;
};

const GROUP_META: Record<
  ContextChunk["group"],
  { label: string; swatch: string }
> = {
  instructions: { label: "Instructions", swatch: "bg-[hsl(var(--notfair-accent))]" },
  tools: { label: "Tool definitions", swatch: "bg-[hsl(217_60%_55%)]" },
  conversation: { label: "Conversation", swatch: "bg-[hsl(38_80%_55%)]" },
};

const FREE_SWATCH = "bg-[hsl(var(--notfair-ink-4)/0.18)]";

/** 36_308 → "36.3k", 272_000 → "272k", 319 → "319". */
function fmtK(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; chunks: ContextChunk[]; total: number };

export function GoalContextDialog({
  projectSlug,
  agentSlug,
  agentId,
  threadId,
  models,
}: {
  projectSlug: string;
  /** URL slug — keys the composer's model-override localStorage entry. */
  agentSlug: string;
  agentId: string;
  threadId: string;
  models: ContextModelOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [expanded, setExpanded] = useState<string | null>(null);
  // The composer's override, read fresh each time the dialog opens (the
  // user may have switched models since). "" = no override stored.
  const [overrideModel, setOverrideModel] = useState("");

  // Mirror the chat composer's resolution exactly: localStorage override
  // when it names a known model, else the harness default.
  const selected = useMemo(
    () =>
      models.find((m) => m.value === overrideModel) ??
      models.find((m) => m.is_default) ??
      models[0],
    [models, overrideModel],
  );
  const window = selected?.context_window;

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const r = await getGoalContextAction({
      project_slug: projectSlug,
      agent_id: agentId,
      thread: threadId,
    });
    if (r.ok) setState({ phase: "ready", chunks: r.chunks, total: r.total_tokens });
    else setState({ phase: "error", message: r.error });
  }, [projectSlug, agentId, threadId]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // `window` is shadowed by the context-window const above.
      setOverrideModel(
        globalThis.localStorage?.getItem(`NotFair:model:${projectSlug}:${agentSlug}`) ?? "",
      );
      if (state.phase === "idle") void load();
    }
    if (!next) setExpanded(null);
  }

  // Denominator: the model's window when known, else the measured total.
  const denom =
    state.phase === "ready" ? (window && window > state.total ? window : state.total) : 0;
  const pct = (tokens: number) => (denom > 0 ? (tokens / denom) * 100 : 0);

  const groupTotals =
    state.phase === "ready"
      ? (Object.keys(GROUP_META) as ContextChunk["group"][]).map((g) => ({
          group: g,
          tokens: state.chunks
            .filter((c) => c.group === g)
            .reduce((a, c) => a + c.tokens, 0),
        }))
      : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="ns-chip"
          title="What fills this agent's context window"
        >
          <Layers className="size-3.5" aria-hidden />
          Context
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[82vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Layers className="size-4" aria-hidden />
            Context window
          </DialogTitle>
          <DialogDescription>
            What this goal&rsquo;s agent works with each turn. Token counts are
            estimates (~4 characters per token) — click any row for the exact
            content.
          </DialogDescription>
        </DialogHeader>

        {state.phase === "loading" && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-[hsl(var(--notfair-ink-4))]">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Measuring instruction files, tool schemas, and the conversation…
          </div>
        )}
        {state.phase === "error" && (
          <p className="py-4 text-[13px] text-[hsl(0_72%_51%)]">{state.message}</p>
        )}

        {state.phase === "ready" && (
          <>
            {/* Headline: used-of-window against the model the chat actually
                uses — window sizes come from the harness's own model
                metadata. */}
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="m-0 text-[20px] font-semibold tabular-nums">
                ≈{fmtK(state.total)}
                {window ? (
                  <>
                    <span className="text-[hsl(var(--notfair-ink-4))]"> of </span>
                    {fmtK(window)}
                    <span className="ml-2 text-[13px] font-normal text-[hsl(var(--notfair-ink-3))]">
                      {((state.total / window) * 100).toFixed(1)}% used
                    </span>
                  </>
                ) : (
                  <span className="ml-1 text-[13px] font-normal text-[hsl(var(--notfair-ink-4))]">
                    tokens (window size unknown for this model)
                  </span>
                )}
              </p>
              {selected && (
                <span className="text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
                  window of {selected.label}
                  {window ? ` · ${fmtK(window)}` : ""}
                </span>
              )}
            </div>

            {/* Near/over the window: say what actually happens, before the
                user has to wonder. The harness compacts on its own; the
                goal's operating state never lives in the window. */}
            {window !== undefined && state.total >= window * 0.8 && (
              <div className="rounded-md bg-[hsl(var(--notfair-warn-soft))] px-3 py-2 text-[12px] leading-relaxed text-[hsl(var(--notfair-warn))]">
                <b>
                  {state.total >= window
                    ? "This conversation has outgrown the window."
                    : "Approaching the window."}
                </b>{" "}
                The harness automatically compacts older turns to keep the
                thread going — nothing breaks, but compacted turns are
                summarized and lose detail. The goal itself is not at risk:
                its metric, actions, and memory live in NotFair&rsquo;s
                database, the agent&rsquo;s instructions are re-sent every
                turn, and every check runs from a fresh, self-contained
                brief.
              </div>
            )}

            {/* Stacked bar of the WHOLE window; the muted tail is free space. */}
            <div
              className="flex h-4 w-full overflow-hidden rounded-md"
              role="img"
              aria-label={
                window
                  ? `Estimated ${fmtK(state.total)} of ${fmtK(window)} tokens used`
                  : `Estimated ${fmtK(state.total)} tokens`
              }
            >
              {state.chunks.map((c) => (
                <span
                  key={c.key}
                  className={cn(
                    GROUP_META[c.group].swatch,
                    "border-r border-[hsl(var(--background))] last:border-r-0",
                  )}
                  style={{ width: `${Math.max(0.5, pct(c.tokens))}%` }}
                  title={`${c.label} — ~${fmtK(c.tokens)} tokens`}
                />
              ))}
              {window && window > state.total && (
                <span
                  className={cn(FREE_SWATCH, "flex-1")}
                  title={`Free — ~${fmtK(window - state.total)} tokens`}
                />
              )}
            </div>

            {/* Group subtotals as the legend — text carries identity. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[hsl(var(--notfair-ink-3))]">
              {groupTotals.map(({ group, tokens }) => (
                <span key={group} className="inline-flex items-center gap-1.5 tabular-nums">
                  <span className={cn("size-2 rounded-[2px]", GROUP_META[group].swatch)} aria-hidden />
                  {GROUP_META[group].label} ~{fmtK(tokens)}
                </span>
              ))}
              {window && window > state.total && (
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <span className={cn("size-2 rounded-[2px]", FREE_SWATCH)} aria-hidden />
                  Free ~{fmtK(window - state.total)}
                </span>
              )}
            </div>

            <ul className="m-0 flex list-none flex-col p-0">
              {state.chunks.map((c) => {
                const isOpen = expanded === c.key;
                const share = pct(c.tokens);
                return (
                  <li key={c.key}>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : c.key)}
                      className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-2.5 text-left text-[13px] transition-colors hover:bg-[hsl(var(--notfair-surface-2))]"
                      aria-expanded={isOpen}
                    >
                      <ChevronRight
                        className={cn("size-3.5 shrink-0 text-[hsl(var(--notfair-ink-4))] transition-transform", isOpen && "rotate-90")}
                        aria-hidden
                      />
                      <span className={cn("size-2 shrink-0 rounded-[2px]", GROUP_META[c.group].swatch)} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {/* per-row share of the window, as a quiet inline bar */}
                      <span className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[hsl(var(--notfair-ink-4)/0.12)] sm:block" aria-hidden>
                        <span
                          className={cn("block h-full", GROUP_META[c.group].swatch)}
                          style={{ width: `${Math.min(100, Math.max(1.5, share))}%` }}
                        />
                      </span>
                      <span className="w-16 shrink-0 text-right tabular-nums text-[12px] text-[hsl(var(--notfair-ink-3))]">
                        ~{fmtK(c.tokens)}
                      </span>
                      <span className="w-12 shrink-0 text-right tabular-nums text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
                        {share < 0.1 ? "<0.1" : share.toFixed(1)}%
                      </span>
                    </button>
                    {isOpen && (
                      <div className="mb-3 ml-6">
                        {c.note && (
                          <p className="m-0 mb-1.5 text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
                            {c.note}
                          </p>
                        )}
                        {c.format === "json" ? (
                          <pre className="m-0 max-h-72 overflow-auto rounded-md bg-[hsl(var(--notfair-ink)/0.04)] p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-[hsl(var(--notfair-ink-2))]">
                            {c.content}
                          </pre>
                        ) : (
                          <div className="max-h-72 overflow-auto rounded-md bg-[hsl(var(--notfair-ink)/0.04)] p-3">
                            <Markdown className="text-[12px]">{c.content}</Markdown>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="m-0 text-[11px] leading-snug text-[hsl(var(--notfair-ink-4))]">
              Not shown: the harness&rsquo;s own base prompt and its full
              tool-output history — those live inside the runtime and
              aren&rsquo;t visible to NotFair.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
