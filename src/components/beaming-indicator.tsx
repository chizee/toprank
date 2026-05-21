"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Active "agent is working" indicator. Mimics the Claude Code CLI's
 * "✳ Beaming…" / "✳ Pondering…" pattern: an asterisk glyph that
 * morphs every ~120 ms paired with a quirky verb that swaps every
 * ~2.5 s. The point is to make the chat view obviously alive during
 * the 10–20s pre-first-token wait — a single small pulsing dot is
 * easy to miss and reads as "stuck".
 *
 * Pure visual. The verb cycles independently of any backend signal —
 * lifecycle/tool info, when available, is shown by the parent in a
 * separate row (we don't try to claim the model is "Pondering" while
 * it's actually executing a tool call). Use this only in the "we
 * don't have a better label" branch of WorkingStatus.
 */

// Quirky verbs lifted in spirit from Claude Code. Kept short so they
// don't reflow the headline as they swap. New entries should also be
// gerunds ("-ing") so the trailing "…" reads naturally.
const VERBS = [
  "Beaming",
  "Brewing",
  "Cogitating",
  "Computing",
  "Conjuring",
  "Crunching",
  "Deliberating",
  "Distilling",
  "Effervescing",
  "Elaborating",
  "Mulling",
  "Musing",
  "Percolating",
  "Pondering",
  "Processing",
  "Ruminating",
  "Simmering",
  "Spinning",
  "Sublimating",
  "Synthesizing",
  "Thinking",
  "Tinkering",
  "Whirring",
] as const;

// Glyph sequence the leading "✳" morphs through. Bright/sparse to dense/full
// and back so the eye reads it as one pulsing thing rather than a flicker.
const GLYPHS = ["✳", "✺", "✷", "✸", "✹", "✷", "✺"] as const;

const GLYPH_INTERVAL_MS = 130;
const VERB_INTERVAL_MS = 2_500;

function useTickingIndex(intervalMs: number, length: number): number {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (length <= 1) return;
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, length]);
  return idx;
}

function useRandomCycle(intervalMs: number, length: number): number {
  // Random pick each tick (skip same-as-current so it always moves) so
  // the user doesn't see the same fixed sequence and decide it's a loop.
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * length));
  useEffect(() => {
    if (length <= 1) return;
    const id = setInterval(() => {
      setIdx((current) => {
        if (length <= 1) return current;
        let next = Math.floor(Math.random() * length);
        if (next === current) next = (next + 1) % length;
        return next;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, length]);
  return idx;
}

export function BeamingHeadline({
  className,
  prefix,
}: {
  className?: string;
  /** Optional agent name prefix, rendered before the verb (e.g. "CMO ·"). */
  prefix?: string | null;
}) {
  const glyphIdx = useTickingIndex(GLYPH_INTERVAL_MS, GLYPHS.length);
  const verbIdx = useRandomCycle(VERB_INTERVAL_MS, VERBS.length);
  const glyph = GLYPHS[glyphIdx]!;
  const verb = VERBS[verbIdx]!;
  return (
    <span
      role="status"
      aria-label={`${verb}…`}
      className={cn("inline-flex items-baseline gap-1.5", className)}
    >
      <BeamingGlyph glyph={glyph} />
      <span className="italic text-muted-foreground">
        {prefix ? `${prefix} ` : ""}
        {verb}
        <AnimatedDots />
      </span>
    </span>
  );
}

/** Just the morphing glyph, for places that already render their own text. */
export function BeamingGlyph({
  className,
  glyph,
}: {
  className?: string;
  glyph?: string;
}) {
  const idx = useTickingIndex(GLYPH_INTERVAL_MS, GLYPHS.length);
  const ch = glyph ?? GLYPHS[idx]!;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block text-sky-500 motion-safe:transition-opacity",
        className,
      )}
    >
      {ch}
    </span>
  );
}

/** Trailing "…" that grows from "." to "..." over time. */
function AnimatedDots() {
  const idx = useTickingIndex(450, 4); // 0=" ", 1=".", 2="..", 3="..."
  const dots = idx === 0 ? "" : ".".repeat(idx);
  return (
    <span aria-hidden className="inline-block w-3 text-left">
      {dots}
    </span>
  );
}
