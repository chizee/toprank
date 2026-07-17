"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LockOpen } from "lucide-react";
import { releaseLockAction } from "@/server/actions/goals";
import { timeAgo, timeUntil } from "@/lib/time-ago";

/**
 * The goal's MOVES — work the agent has already done, shown as a journal,
 * never as a to-do list. The agent logs each move the moment it acts;
 * the move then sits in an observation window while its effect matures
 * ("observing"), and once the window ends the outcome gets scored at the
 * next check ("outcome check queued"). Research notes and decisions have
 * no window at all.
 *
 * The stage chip leads every card so the agent's imperative descriptions
 * ("Open one listing PR to …") read as titles of finished work.
 */

export type MoveRow = {
  action_id: string;
  kind: "mutation" | "research" | "decision";
  /** What the agent did — its own words, logged as it acted. */
  description: string;
  /** Parsed resources_touched_json — locked while observing. */
  resources: string[];
  /** ISO time the move was made (and logged). */
  made_at: string;
  /** ISO end of the observation window; null = no window (notes). */
  observe_until: string | null;
};

export type MoveStage = "observing" | "outcome-due" | "note";

export function moveStage(move: MoveRow, now = Date.now()): MoveStage {
  if (!move.observe_until) return "note";
  return Date.parse(move.observe_until) > now ? "observing" : "outcome-due";
}

export type ParsedResource = {
  /** Label prefix (`local`, `github`, `xads`, `page`, …); null if none. */
  scope: string | null;
  /** The thing itself: a file, an `owner/repo`, a campaign id, a path. */
  name: string;
  /** Humanized `#fragment` — the subset of the resource actually locked. */
  detail: string | null;
  /** Outbound link when the name is unambiguous (GitHub repos). */
  href: string | null;
};

export function parseResourceLabel(raw: string): ParsedResource {
  const m = raw.match(/^([a-z][\w-]*):(.+)$/i);
  const scope = m ? m[1]! : null;
  let name = m ? m[2]! : raw;
  let detail: string | null = null;
  const hash = name.indexOf("#");
  if (hash > 0) {
    // Fragments are kebab-case notes ("the-nine-blank-pr_url-rows…") —
    // dashes become spaces; underscores stay (they're inside identifiers).
    detail = name
      .slice(hash + 1)
      .replace(/-+/g, " ")
      .trim();
    name = name.slice(0, hash);
  }
  const href =
    scope === "github" && /^[\w.-]+\/[\w.-]+$/.test(name)
      ? `https://github.com/${name}`
      : null;
  return { scope, name, detail, href };
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Elapsed share of the observation window, 0..1. */
function windowProgress(made_at: string, observe_until: string, now = Date.now()): number {
  const start = Date.parse(made_at);
  const end = Date.parse(observe_until);
  if (!(end > start)) return 1;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

const SECTION: Record<MoveStage, { title: string; blurb: string }> = {
  observing: {
    title: "Done — observing the effect",
    blurb:
      "The move is made; its resources stay untouched until the window ends so the effect can be measured cleanly.",
  },
  "outcome-due": {
    title: "Done — outcome check queued",
    blurb: "The window is over; the agent scores what actually happened at its next check.",
  },
  note: {
    title: "Notes & decisions",
    blurb: "Research and decisions the agent recorded — no observation window.",
  },
};

export function GoalMoves({
  moves,
  nextCheckAt,
}: {
  moves: MoveRow[];
  /** ISO time of the next scheduled check, for the outcome-due hint. */
  nextCheckAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function unlock(action_id: string) {
    startTransition(async () => {
      const r = await releaseLockAction(action_id);
      if (!r.ok) {
        toast.error(r.error ?? "Could not unlock.");
        return;
      }
      toast.success("Unlocked — the outcome check is now queued for the next check.");
      router.refresh();
    });
  }

  const groups: Array<{ stage: MoveStage; items: MoveRow[] }> = [
    {
      stage: "observing",
      items: moves
        .filter((m) => moveStage(m) === "observing")
        .sort((a, b) => a.observe_until!.localeCompare(b.observe_until!)),
    },
    {
      stage: "outcome-due",
      items: moves
        .filter((m) => moveStage(m) === "outcome-due")
        .sort((a, b) => a.made_at.localeCompare(b.made_at)),
    },
    {
      stage: "note",
      items: moves
        .filter((m) => moveStage(m) === "note")
        .sort((a, b) => b.made_at.localeCompare(a.made_at)),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.stage} aria-label={SECTION[g.stage].title}>
            <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-[hsl(var(--notfair-ink-3))]">
              {SECTION[g.stage].title}
              <span className="ml-1 font-normal tabular-nums">({g.items.length})</span>
            </h3>
            <p className="m-0 mt-0.5 mb-2 text-[11.5px] leading-snug text-[hsl(var(--notfair-ink-4))]">
              {SECTION[g.stage].blurb}
            </p>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {g.items.map((move) => (
                <MoveCard
                  key={move.action_id}
                  move={move}
                  nextCheckAt={nextCheckAt}
                  pending={pending}
                  onUnlock={unlock}
                />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function MoveCard({
  move,
  nextCheckAt,
  pending,
  onUnlock,
}: {
  move: MoveRow;
  nextCheckAt: string | null;
  pending: boolean;
  onUnlock: (action_id: string) => void;
}) {
  const stage = moveStage(move);
  return (
    <li className="rounded-xl bg-[hsl(var(--notfair-surface-2)/0.5)] px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-[hsl(var(--notfair-ink-4))]">
          {stage === "note" ? (
            <span className="ns-tag-mono mr-1.5">{move.kind}</span>
          ) : (
            <span className="ns-tag mr-1.5">✓ done</span>
          )}
          made {timeAgo(move.made_at)}
        </span>
        {stage === "observing" && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onUnlock(move.action_id)}
            className="ns-btn ns-btn-outline ns-btn-sm shrink-0"
            title="End the observation window now — the outcome check moves to the next check"
          >
            <LockOpen className="size-3" aria-hidden />
            Unlock
          </button>
        )}
      </div>

      {/* The move itself — the agent's own record, in full. */}
      <p className="m-0 mt-2 text-[12.5px] leading-relaxed text-[hsl(var(--notfair-ink-2))]">
        {move.description}
      </p>

      {stage === "observing" && (
        <>
          {move.resources.length > 0 && (
            <ul className="m-0 mt-2.5 flex list-none flex-col gap-1 p-0">
              {move.resources.map((raw) => {
                const r = parseResourceLabel(raw);
                return (
                  <li key={raw} className="text-[12px] leading-relaxed">
                    <span className="text-[hsl(var(--notfair-ink-4))]">🔒 </span>
                    {r.scope && (
                      <span className="ns-tag-mono mr-1.5 align-[1px]">{r.scope}</span>
                    )}
                    {r.href ? (
                      <a
                        href={r.href}
                        target="_blank"
                        rel="noreferrer"
                        className="ns-link font-medium break-all"
                      >
                        {r.name}
                      </a>
                    ) : (
                      <span className="font-medium break-all">{r.name}</span>
                    )}
                    {r.detail && (
                      <span className="text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
                        {" "}
                        — only {r.detail}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-2.5">
            <div
              className="h-1 overflow-hidden rounded-full bg-[hsl(var(--notfair-warn)/0.18)]"
              role="progressbar"
              aria-label="Observation window elapsed"
              aria-valuenow={Math.round(
                windowProgress(move.made_at, move.observe_until!) * 100,
              )}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-[hsl(var(--notfair-warn))]"
                style={{
                  width: `${Math.max(2, windowProgress(move.made_at, move.observe_until!) * 100)}%`,
                }}
              />
            </div>
            <p className="m-0 mt-1.5 text-right text-[11px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
              observation ends {timeUntil(move.observe_until!)} ·{" "}
              {fmtWhen(move.observe_until!)}
            </p>
          </div>
        </>
      )}

      {stage === "outcome-due" && (
        <p className="m-0 mt-2 text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
          The agent records what actually happened at its next check
          {nextCheckAt ? ` · ${fmtWhen(nextCheckAt)}` : ""}.
        </p>
      )}
    </li>
  );
}
