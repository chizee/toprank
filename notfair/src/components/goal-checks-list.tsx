"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { loadMoreGoalChecksAction } from "@/server/actions/goals";
import type { CheckFilter, CheckPr, CheckRow } from "@/server/goals/checks";
import { projectHref } from "@/lib/project-href";
import { formatMetric } from "@/lib/format-metric";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";

/**
 * The goal rail's Checks diary. Server-renders the newest page; older
 * checks stream in as the sentinel scrolls into view (cursor-paged by
 * tick_number). The page's 5s auto-refresh re-sends the first page, which
 * is merged in by id so freshly loaded history is never dropped.
 *
 * The "Action taken" filter hides observe-only checks (no action recorded,
 * no PR). Rows are kept in one merged store and filtered at render time,
 * so the auto-refresh merge stays filter-agnostic; pagination re-queries
 * the server with the filter so skipped checks don't count against pages.
 */
export function GoalChecksList({
  slug,
  agentSlug,
  goalId,
  initialRows,
  initialHasMore,
}: {
  slug: string;
  agentSlug: string;
  goalId: string;
  initialRows: CheckRow[];
  initialHasMore: boolean;
}) {
  const [rows, setRows] = useState<CheckRow[]>(initialRows);
  const [filter, setFilter] = useState<CheckFilter>("all");
  // hasMore is tracked per filter: only load responses for a given filter
  // update it. "action" starts unknown (null) until its first page loads.
  const [hasMoreAll, setHasMoreAll] = useState(initialHasMore);
  const [hasMoreAction, setHasMoreAction] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const visible = filter === "action" ? rows.filter(tookAction) : rows;
  // The observer callback outlives renders; read visible rows via a ref.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    setRows((prev) => mergeRows(prev, initialRows));
  }, [initialRows]);

  // First switch to "Action taken": the loaded window may hold few or no
  // matching rows, so fetch the newest filtered page from the server.
  useEffect(() => {
    if (filter !== "action" || hasMoreAction !== null) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    loadMoreGoalChecksAction(goalId, undefined, "action")
      .then((res) => {
        setRows((prev) => mergeRows(prev, res.rows));
        setHasMoreAction(res.hasMore);
      })
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }, [filter, hasMoreAction, goalId]);

  const hasMore = filter === "action" ? (hasMoreAction ?? false) : hasMoreAll;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(async (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const shown = visibleRef.current;
        const oldest =
          shown.length > 0 ? Math.min(...shown.map((r) => r.tick_number)) : undefined;
        const res = await loadMoreGoalChecksAction(
          goalId,
          oldest,
          filter === "action" ? "action" : undefined,
        );
        setRows((prev) => mergeRows(prev, res.rows));
        if (filter === "action") setHasMoreAction(res.hasMore);
        else setHasMoreAll(res.hasMore);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [goalId, hasMore, filter]);

  if (rows.length === 0) return null;

  return (
    <>
      <div className="mb-2 flex items-center gap-1" role="group" aria-label="Filter checks">
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterButton>
        <FilterButton active={filter === "action"} onClick={() => setFilter("action")}>
          Action taken
        </FilterButton>
      </div>
      {visible.length === 0 && !loading ? (
        <p className="m-0 text-[12px] text-[hsl(var(--notfair-ink-4))]">
          No checks took action yet.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border/40 p-0">
          {visible.map((t) => (
            <CheckItem key={t.id} slug={slug} agentSlug={agentSlug} tick={t} />
          ))}
        </ul>
      )}
      {(hasMore || loading) && (
        <div ref={sentinelRef} className="flex justify-center py-2">
          {loading && (
            <Loader2 className="size-3.5 animate-spin text-[hsl(var(--notfair-ink-4))]" />
          )}
        </div>
      )}
    </>
  );
}

/** A check "took action" when it recorded an action or registered a PR. */
function tookAction(row: CheckRow): boolean {
  return row.actions_count > 0 || row.prs.length > 0;
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-[hsl(var(--notfair-surface-2))] text-[hsl(var(--notfair-ink-2))]"
          : "text-[hsl(var(--notfair-ink-4))] hover:text-[hsl(var(--notfair-ink-3))]",
      )}
    >
      {children}
    </button>
  );
}

/** Upsert incoming rows by id, newest check first. */
function mergeRows(prev: CheckRow[], incoming: CheckRow[]): CheckRow[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.tick_number - a.tick_number);
}

function CheckItem({
  slug,
  agentSlug,
  tick,
}: {
  slug: string;
  agentSlug: string;
  tick: CheckRow;
}) {
  const threadLabel = tick.trigger_kind === "intake" ? "main" : `tick-${tick.tick_number}`;
  return (
    <li className="py-2.5 text-[12px] leading-snug first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          Check {tick.tick_number}
          {tick.trigger_kind === "manual" && (
            <span className="ns-tag ml-1.5 align-middle">manually triggered</span>
          )}
          {tick.metric_value !== null && (
            <span className="ml-1.5 font-normal tabular-nums text-[hsl(var(--notfair-ink-3))]">
              → {formatMetric(tick.metric_value)}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
          {timeAgo(tick.started_at)}
        </span>
      </div>
      {tick.metric_error && (
        <p className="m-0 text-[11.5px] text-[hsl(0_72%_51%)]">{tick.metric_error}</p>
      )}
      <div className="line-clamp-2 text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
        <Markdown className="text-[11.5px] text-[hsl(var(--notfair-ink-4))] [&_p]:m-0 [&_p]:inline [&_p+p]:before:content-['_']">
          {tick.status === "running"
            ? "running…"
            : tick.status === "failed"
              ? `failed: ${tick.summary ?? "(no detail)"}`
              : (tick.summary ?? "(no summary)")}
        </Markdown>
      </div>
      {/* Running agent checks are watchable live: the session attaches at
          turn start and the check page's transcript polls as it streams.
          No-op checks never carry a session and stay unlinked. */}
      {(tick.session_id || tick.status === "running" || tick.prs.length > 0) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {(tick.session_id || tick.status === "running") && (
            <Link
              href={projectHref(slug, `/goals/${agentSlug}/checks/${threadLabel}`)}
              className="ns-link text-[10.5px]"
            >
              {tick.status === "running" ? "watch live ›" : "details ›"}
            </Link>
          )}
          {tick.prs.map((pr) => (
            <CheckPrButton key={pr.id} pr={pr} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Compact colored PR pill on a check row — links straight to GitHub. */
function CheckPrButton({ pr }: { pr: CheckPr }) {
  const number = pr.url.match(/\/pull\/(\d+)$/)?.[1];
  const tone =
    pr.state === "open"
      ? "ns-tag-accent"
      : pr.state === "merged"
        ? "bg-[hsl(217_60%_55%/0.14)] text-[hsl(217_60%_45%)] dark:text-[hsl(217_70%_70%)]"
        : "ns-tag-red";
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={pr.title}
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
        tone,
      )}
    >
      PR{number ? ` #${number}` : ""} · {pr.state}
    </a>
  );
}
