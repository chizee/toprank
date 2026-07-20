import type { TranscriptEvent } from "@/server/sessions/transcript-tail";
import type { WorkingMood, WorkingPhase } from "@/components/working-indicator";
import { humanizeTool } from "./tool-intent";
import type { ToolEntry } from "./transcript-model";

/**
 * Derivation of the "agent is working" indicator's visible state from a
 * mix of SSE-leading pending state and DB-trailing committed events.
 * Pure functions only — the LiveWorkingIndicator component owns the
 * clock and renders the result.
 */

export type WorkingView = {
  headline: string;
  subtitle: string | null;
  phases: WorkingPhase[];
  mood: WorkingMood;
};

/**
 * How long the last assistant message may sit as the newest event before
 * "Wrapping up" stops being a credible description of the turn. Past
 * this, the agent is demonstrably NOT wrapping up — it's working silently
 * toward its next step (Codex emits nothing while reasoning).
 */
export const WRAPPING_STALE_MS = 30_000;

/**
 * Build the visible state for the working indicator.
 *
 * Precedence (most-specific first):
 *   1. An SSE-pending tool start that hasn't reported a result → that's
 *      the active phase, mood "tool".
 *   2. An SSE-pending assistant text stream → mood "writing".
 *   3. No events yet (pre-first-token kickoff wait) → mood "waiting"
 *      with the gateway lifecycle hint as subtitle.
 *   4. A committed in-flight tool_call → mood "tool" (polling caught up
 *      before the SSE state did, e.g. on rejoin from another tab).
 *   5. Last committed event is a tool_result → mood "waiting".
 *   6. Last committed event is assistant_text → mood "wrapping" while the
 *      message is fresh; once it goes stale (WRAPPING_STALE_MS) the agent
 *      is mid-work on its next step, not wrapping — mood "waiting" with
 *      an honest "quiet for Xm" subtitle.
 *
 * Phases are derived from BOTH sources so the trajectory chips include
 * recent SSE tools the DB hasn't seen yet, then dedupe by tool name.
 */
export function deriveWorkingView(input: {
  agentDisplayName: string;
  events: TranscriptEvent[];
  lifecyclePhase: string | null;
  pendingTools: ToolEntry[];
  hasPendingAssistant: boolean;
  /**
   * Wallclock when the current turn started. We use it to scope the
   * trajectory chips (and the in-flight tool detection) to the active
   * turn — events from earlier turns in the same thread don't belong
   * in "what is the agent doing right now?".
   */
  turnStartedAt: number | null;
  /** Current wallclock (the caller's 1Hz tick) for staleness checks. */
  now: number;
}): WorkingView {
  const {
    events,
    lifecyclePhase,
    pendingTools,
    hasPendingAssistant,
    turnStartedAt,
    now,
  } = input;
  // Only consider events from the current turn. Anything older is part
  // of the persistent transcript above this card, not the live status.
  const turnEvents =
    turnStartedAt != null ? events.filter((e) => e.ts >= turnStartedAt) : events;
  // Turn-ended signal: the harness emits a `final` event when its run
  // completes; transcript-tail surfaces it as `{ kind: "lifecycle",
  // phase: "done" }`. Once we've seen it, the agent has stopped producing
  // tokens. Keep the trajectory chips, but switch every live affordance
  // to the static completed presentation.
  const turnEnded = turnEvents.some(
    (e) => e.kind === "lifecycle" && e.phase === "done",
  );
  const lastEvent =
    turnEvents.length > 0 ? turnEvents[turnEvents.length - 1] : null;
  const pendingInFlightTool = pendingTools.find((t) => !t.done) ?? null;
  const inFlightCommittedToolCall: Extract<
    TranscriptEvent,
    { kind: "tool_call" }
  > | null = (() => {
    if (!lastEvent || lastEvent.kind !== "tool_call") return null;
    const matched = turnEvents.some(
      (e) => e.kind === "tool_result" && e.tool_call_id === lastEvent.tool_call_id,
    );
    return matched ? null : lastEvent;
  })();
  const phases = buildPhases(turnEvents, pendingTools);

  // Highest precedence: the harness has emitted its normal final event.
  // This is a completed turn, not a parked task and not an error.
  if (turnEnded && !pendingInFlightTool && !hasPendingAssistant) {
    return { headline: "Turn complete", subtitle: null, phases, mood: "ended" };
  }

  if (pendingInFlightTool) {
    const intent = humanizeTool(
      pendingInFlightTool.name,
      pendingInFlightTool.label,
    );
    return {
      headline: intent.verb,
      subtitle: intent.target ?? pendingInFlightTool.label ?? null,
      phases,
      mood: "tool",
    };
  }
  if (hasPendingAssistant) {
    return {
      headline: "Writing the response",
      subtitle: subtitleForLastTool(pendingTools, turnEvents),
      phases,
      mood: "writing",
    };
  }
  // Between-tools window: SSE has seen at least one tool finish this
  // turn but the model hasn't started the next thing yet (no in-flight
  // pending tool, no streaming text, no fresh transcript event because Codex
  // buffers the file until end-of-turn). Without this branch we'd fall
  // through to "Starting", which is wrong — the agent IS thinking, just
  // about its next move. Surface the last tool so the user has context.
  if (pendingTools.length > 0) {
    const lastDone = [...pendingTools].reverse().find((t) => t.done);
    return {
      headline: "Thinking",
      subtitle: lastDone
        ? `${humanizeTool(lastDone.name, lastDone.label).verb} ${lastDone.ok ? "✓" : "failed"} — picking next step`
        : null,
      phases,
      mood: "waiting",
    };
  }
  if (
    !lastEvent ||
    lastEvent.kind === "user_message" ||
    lastEvent.kind === "unknown"
  ) {
    // The gateway lifecycle phase IS the status when it arrives — showing
    // "Starting" with a "Calling the model" subtitle stacked two
    // contradictory descriptions of the same moment. Promote whichever
    // signal we have to the headline; the generic "Starting" only fires
    // before any lifecycle event lands.
    const lifecycleSummary = lifecyclePhase
      ? humanLifecyclePhase(lifecyclePhase)
      : null;
    return {
      headline: lifecycleSummary ?? "Starting",
      subtitle: null,
      phases,
      mood: "waiting",
    };
  }
  if (inFlightCommittedToolCall) {
    const intent = humanizeTool(
      inFlightCommittedToolCall.name,
      inFlightCommittedToolCall.label,
    );
    return {
      headline: intent.verb,
      subtitle: intent.target ?? inFlightCommittedToolCall.label ?? null,
      phases,
      mood: "tool",
    };
  }
  if (lastEvent.kind === "tool_result") {
    const verb = humanizeTool(lastEvent.name, null).verb;
    return {
      headline: "Thinking",
      subtitle: lastEvent.ok
        ? `${verb} ✓ — picking next step`
        : `${verb} failed — retrying`,
      phases,
      mood: "waiting",
    };
  }
  // assistant_text. "Wrapping up" is only true for the brief gap between
  // the closing message and the turn's `final` event (sub-second on
  // Codex, a few seconds on Claude Code). Codex delivers whole messages
  // BETWEEN work phases and then goes silent — no deltas, no tool events
  // — while it reasons toward its next tool call, so an intermediate
  // narration message left "Wrapping up" spinning for many minutes and
  // read as hung. Once the message goes stale, say what's actually
  // happening: the agent is still mid-turn and has been quiet for a while.
  if (now - lastEvent.ts > WRAPPING_STALE_MS) {
    return {
      headline: "Still working",
      subtitle: `quiet for ${formatQuietFor(now - lastEvent.ts)} — progress updates from this harness can be sparse`,
      phases,
      mood: "waiting",
    };
  }
  return {
    headline: "Wrapping up",
    subtitle: subtitleForLastTool(pendingTools, events),
    phases,
    mood: "wrapping",
  };
}

function formatQuietFor(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 90) return `${sec}s`;
  return `${Math.floor(sec / 60)}m`;
}

function subtitleForLastTool(
  pendingTools: ToolEntry[],
  events: TranscriptEvent[],
): string | null {
  const lastDonePending = [...pendingTools].reverse().find((t) => t.done);
  if (lastDonePending) {
    const verb = humanizeTool(lastDonePending.name, lastDonePending.label).verb;
    return `${verb} ${lastDonePending.ok ? "✓" : "failed"}`;
  }
  const lastDoneCommitted = [...events]
    .reverse()
    .find((e): e is Extract<TranscriptEvent, { kind: "tool_result" }> =>
      e.kind === "tool_result",
    );
  if (lastDoneCommitted) {
    const verb = humanizeTool(lastDoneCommitted.name, null).verb;
    return `${verb} ${lastDoneCommitted.ok ? "✓" : "failed"}`;
  }
  return null;
}

/**
 * Build the trajectory pills shown in the indicator. Order:
 *   1. Committed tools (in order, deduped by tool_call_id).
 *   2. SSE-pending tools not yet in the committed list.
 * The last entry is the "active" one. Done entries get a check, the
 * active one gets the mood-colored ring + wrench glyph.
 */
export function buildPhases(
  events: TranscriptEvent[],
  pendingTools: ToolEntry[],
): WorkingPhase[] {
  const seen = new Set<string>();
  const phases: WorkingPhase[] = [];

  // Walk committed events to build phases in order. Capture the `label`
  // from the tool_call (where it lives) so the phase chip's intent
  // matches what the inline ToolGroup row shows — without it, shell
  // commands collapse to "Ran shell command" in the trajectory.
  const committedById = new Map<
    string,
    { name: string; label: string | null; done: boolean; ok: boolean }
  >();
  for (const e of events) {
    if (e.kind === "tool_call") {
      committedById.set(e.tool_call_id, {
        name: e.name,
        label: e.label,
        done: false,
        ok: true,
      });
    } else if (e.kind === "tool_result") {
      const prev = committedById.get(e.tool_call_id);
      if (prev) {
        prev.done = true;
        prev.ok = e.ok;
      } else {
        committedById.set(e.tool_call_id, {
          name: e.name,
          label: null,
          done: true,
          ok: e.ok,
        });
      }
    }
  }
  for (const [id, t] of committedById) {
    seen.add(id);
    phases.push({
      id,
      label: humanizeTool(t.name, t.label).verb,
      state: !t.done ? "active" : t.ok ? "done" : "failed",
    });
  }

  // Then any SSE-pending tools the committed list doesn't have yet.
  for (const t of pendingTools) {
    if (seen.has(t.toolCallId)) continue;
    const intent = humanizeTool(t.name, t.label);
    phases.push({
      id: t.toolCallId,
      label: intent.verb,
      state: !t.done ? "active" : t.ok ? "done" : "failed",
      detail: intent.target ?? t.label ?? null,
    });
  }

  // If multiple phases are flagged "active" (shouldn't happen, but defend),
  // demote all but the last so the visual stays clear.
  let lastActive = -1;
  for (let i = 0; i < phases.length; i++) {
    if (phases[i]!.state === "active") lastActive = i;
  }
  return phases.map((p, i) =>
    p.state === "active" && i !== lastActive ? { ...p, state: "done" } : p,
  );
}

/**
 * Translate a harness stream lifecycle phase into a short
 * user-facing label. We don't try to enumerate every possible phase —
 * unknown values fall through to a generic "starting up…" so a future
 * gateway protocol bump doesn't render a blank status.
 */
export function humanLifecyclePhase(phase: string): string {
  const p = phase.toLowerCase();
  // Capitalized + no trailing ellipsis — these strings are used as the
  // indicator's headline alongside "Calling runScript" / "Thinking" /
  // "Writing the response".
  if (p.includes("warming") || p.includes("warmup")) return "Warming up";
  if (p.includes("compact")) return "Compacting context";
  if (p === "start" || p.endsWith(".start") || p.includes("run.start"))
    return "Calling the model";
  if (p.includes("end") || p.includes("complete")) return "Finishing up";
  return "Starting up";
}
