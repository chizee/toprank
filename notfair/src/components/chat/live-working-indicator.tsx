"use client";

import { useEffect, useState } from "react";

import { WorkingIndicator } from "@/components/working-indicator";
import type { TranscriptEvent } from "@/server/sessions/transcript-tail";
import type { ToolEntry } from "./transcript-model";
import { deriveWorkingView } from "./working-view";

/**
 * The bottom-anchored "agent is working" status. Wraps the presentational
 * WorkingIndicator with the live derivation: headline/subtitle/mood/phases
 * from a mix of SSE-leading pending state and DB-trailing committed
 * events, plus the 1Hz elapsed counter.
 */
export function LiveWorkingIndicator({
  agentDisplayName,
  events,
  turnStartedAt,
  lifecyclePhase,
  pendingTools,
  hasPendingAssistant,
}: {
  agentDisplayName: string;
  events: TranscriptEvent[];
  turnStartedAt: number | null;
  lifecyclePhase?: string | null;
  pendingTools?: ToolEntry[];
  hasPendingAssistant?: boolean;
}) {
  const [now, setNow] = useState<number>(() => Date.now());
  // Scope the "done" check to the current turn — an earlier completed
  // turn's done event must not freeze the clock on a live later turn.
  const visiblyEnded =
    events.some(
      (e) =>
        e.kind === "lifecycle" &&
        e.phase === "done" &&
        (turnStartedAt == null || e.ts >= turnStartedAt),
    ) &&
    !pendingTools?.some((t) => !t.done) &&
    !hasPendingAssistant;
  useEffect(() => {
    if (visiblyEnded) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visiblyEnded]);

  const view = deriveWorkingView({
    agentDisplayName,
    events,
    lifecyclePhase: lifecyclePhase ?? null,
    pendingTools: pendingTools ?? [],
    hasPendingAssistant: hasPendingAssistant ?? false,
    // The indicator must only reflect the current turn — without this
    // filter, the trajectory chips show every tool call from the chat's
    // entire history (e.g. a fresh "hi" lit up runScript / runScript /
    // listConnectedAccounts from prior audit turns).
    turnStartedAt,
    now,
  });

  // Anchor elapsed to whichever is later: the turn-start wallclock the
  // composer recorded, or the last event's timestamp. Keeps the counter
  // honest during the SSE-only window where events are still empty.
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const anchorTs = (() => {
    const lastTs = lastEvent?.ts ?? null;
    if (turnStartedAt && lastTs) return Math.max(turnStartedAt, lastTs);
    return turnStartedAt ?? lastTs;
  })();
  const elapsedMs =
    view.mood !== "ended" && anchorTs != null ? Math.max(0, now - anchorTs) : null;

  return (
    <WorkingIndicator
      agentDisplayName={agentDisplayName}
      headline={view.headline}
      subtitle={view.subtitle}
      phases={view.phases}
      mood={view.mood}
      elapsedMs={elapsedMs}
    />
  );
}
