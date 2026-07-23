"use client";

import { Check, CheckCircle2, Loader2, Wrench, X } from "lucide-react";

import { cn } from "@/lib/utils";

export type WorkingPhase = {
  id: string;
  label: string;
  detail?: string | null;
  state: "done" | "active" | "failed";
};

export type WorkingMood = "waiting" | "tool" | "writing" | "wrapping" | "ended";

/**
 * A quiet, Codex-style run status that belongs to the conversation flow.
 * It deliberately avoids card chrome: one state icon, one honest status,
 * and a compact history of the latest tool calls.
 */
export function WorkingIndicator({
  agentDisplayName,
  headline,
  subtitle,
  phases,
  elapsedMs,
  mood,
}: {
  agentDisplayName: string;
  headline: string;
  subtitle?: string | null;
  phases: WorkingPhase[];
  elapsedMs: number | null;
  mood: WorkingMood;
}) {
  if (mood === "writing") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={headline}
        data-run-state="running"
        className="py-1.5 text-xs"
      >
        <span className="ns-shimmer-text font-medium">{headline}</span>
      </div>
    );
  }

  const ended = mood === "ended";
  const visiblePhases = phases.slice(-3);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${agentDisplayName} ${headline}`}
      data-run-state={ended ? "complete" : "running"}
      className="py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {ended ? (
          <CheckCircle2
            className="size-3.5 shrink-0 text-emerald-500"
            aria-hidden
          />
        ) : (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-[hsl(var(--notfair-accent))]"
            aria-hidden
          />
        )}
        <span
          className={cn(
            "font-medium",
            ended ? "text-foreground/90" : "ns-shimmer-text",
          )}
        >
          {headline}
        </span>
        <span className="text-muted-foreground/45">·</span>
        <span className="truncate text-muted-foreground">
          {agentDisplayName}
        </span>
        {!ended && elapsedMs != null && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatElapsed(elapsedMs)}
          </span>
        )}
      </div>

      {subtitle && (
        <div className="mt-1 truncate font-mono text-[10.5px] tracking-tight text-muted-foreground/80">
          {subtitle}
        </div>
      )}

      {visiblePhases.length > 0 && (
        <ol className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {visiblePhases.map((phase) => (
            <li
              key={phase.id}
              className="inline-flex min-w-0 items-center gap-1 text-[10.5px] text-muted-foreground"
            >
              <PhaseIcon phase={phase} animate={!ended} />
              <span className="max-w-44 truncate font-mono">
                {phase.label}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PhaseIcon({
  phase,
  animate,
}: {
  phase: WorkingPhase;
  animate: boolean;
}) {
  if (phase.state === "done") {
    return <Check className="size-3 shrink-0 text-emerald-500" aria-hidden />;
  }
  if (phase.state === "failed") {
    return <X className="size-3 shrink-0 text-destructive" aria-hidden />;
  }
  return (
    <Wrench
      className={cn(
        "size-3 shrink-0 text-muted-foreground",
        animate && "opacity-80",
      )}
      aria-hidden
    />
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `0:${totalSec.toString().padStart(2, "0")}`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
