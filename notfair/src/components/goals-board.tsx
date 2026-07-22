import Link from "next/link";
import { ArrowUpRight, Pin } from "lucide-react";
import { GoalSparkline } from "@/components/goal-sparkline";
import { formatMetric } from "@/lib/format-metric";
import { goalGroupHealth, type GoalGroupHealth } from "@/lib/goal-group-health";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

// Plain JSON is passed from the server route so this dashboard stays cheap to
// render and every card can be a normal link, with no client hydration needed.
type GoalStatus =
  | "intake"
  | "proposed"
  | "active"
  | "paused"
  | "achieved"
  | "failed"
  | "killed";

export type BoardGoal = {
  id: string;
  href: string;
  label: string;
  statement: string;
  status: GoalStatus;
  status_reason: string | null;
  metric_name: string | null;
  current_value: number | null;
  target_value: number | null;
  metric_direction: "increase" | "decrease" | null;
  mode: "achieve" | "maintain";
  tick_count: number;
  pinned: boolean;
  updated_at: string;
  snapshots: number[];
};

export type GoalDashboardSection = {
  id: string;
  name: string;
  description: string;
  href: string | null;
  goals: BoardGoal[];
};

const TERMINAL: GoalStatus[] = ["achieved", "failed", "killed"];

const HEALTH_COPY: Record<
  GoalGroupHealth,
  { label: string; dot: string; text: string }
> = {
  healthy: {
    label: "on target",
    dot: "ns-dot-live",
    text: "text-[hsl(var(--notfair-accent))]",
  },
  attention: {
    label: "needs attention",
    dot: "ns-dot-err",
    text: "text-[hsl(var(--destructive))]",
  },
  waiting: {
    label: "waiting for data",
    dot: "ns-dot-warn",
    text: "text-[hsl(var(--notfair-warn))]",
  },
  paused: {
    label: "paused",
    dot: "ns-dot-mute",
    text: "text-[hsl(var(--notfair-ink-4))]",
  },
  closed: {
    label: "closed",
    dot: "ns-dot-mute",
    text: "text-[hsl(var(--notfair-ink-4))]",
  },
};

/**
 * Workspace-level metric dashboard. Groups provide the page structure and
 * every raised surface is a real navigation target: clicking any metric card
 * opens that goal's full history and chat.
 */
export function GoalsBoard({ sections }: { sections: GoalDashboardSection[] }) {
  const allGoals = sections.flatMap((section) => section.goals);
  const running = allGoals.filter((goal) => goal.status === "active").length;
  const paused = allGoals.filter((goal) => goal.status === "paused").length;
  const closed = allGoals.filter((goal) => TERMINAL.includes(goal.status)).length;

  return (
    <div>
      <div
        className="mb-9 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-[hsl(var(--notfair-ink-4))]"
        aria-label="Goals summary"
      >
        <span className="font-mono tabular-nums">
          {allGoals.length} goal{allGoals.length === 1 ? "" : "s"}
        </span>
        {running > 0 && (
          <span className="flex items-center gap-1.5 text-[hsl(var(--notfair-accent))]">
            <span className="ns-dot ns-dot-live" aria-hidden />
            {running} running
          </span>
        )}
        {paused > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="ns-dot ns-dot-mute" aria-hidden />
            {paused} paused
          </span>
        )}
        {closed > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="ns-dot ns-dot-mute" aria-hidden />
            {closed} closed
          </span>
        )}
      </div>

      <div className="flex flex-col gap-12">
        {sections.map((section) => {
          const goals = [...section.goals].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            if (TERMINAL.includes(a.status) !== TERMINAL.includes(b.status)) {
              return TERMINAL.includes(a.status) ? 1 : -1;
            }
            return b.updated_at.localeCompare(a.updated_at);
          });
          const headingId = `goal-section-${section.id}`;

          return (
            <section key={section.id} aria-labelledby={headingId}>
              <header className="mb-4 flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h2
                      id={headingId}
                      className="m-0 text-[16px] font-semibold tracking-[-0.018em] text-[hsl(var(--notfair-ink-2))]"
                    >
                      {section.name}
                    </h2>
                    <span className="font-mono text-[10.5px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
                      {goals.length} goal{goals.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="m-0 mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-[hsl(var(--notfair-ink-4))]">
                    {section.description}
                  </p>
                </div>
                {section.href && (
                  <Link
                    href={section.href}
                    className="group/link flex shrink-0 items-center gap-1 text-[11.5px] text-[hsl(var(--notfair-ink-4))] transition-colors hover:text-[hsl(var(--notfair-ink-2))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Open group
                    <ArrowUpRight className="size-3 transition-transform group-hover/link:-translate-y-0.5 group-hover/link:translate-x-0.5" />
                  </Link>
                )}
              </header>

              {goals.length === 0 ? (
                <div className="rounded-xl bg-[hsl(var(--notfair-surface-2)/0.42)] px-5 py-8 text-[12.5px] text-[hsl(var(--notfair-ink-4))]">
                  No goals in this group yet. Use <span className="text-[hsl(var(--notfair-ink-3))]">Manage group</span> to add one.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {goals.map((goal) => (
                    <GoalMetricCard key={goal.id} goal={goal} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function GoalMetricCard({ goal }: { goal: BoardGoal }) {
  const health = goalGroupHealth(goal);
  const healthCopy = HEALTH_COPY[health];
  const comparator = goal.metric_direction === "decrease" ? "≤" : "≥";
  const metricReady = goal.metric_name !== null;
  const hasChart = goal.snapshots.length >= 2;
  const accessibleTarget =
    goal.target_value === null
      ? ""
      : `, ${goal.mode === "maintain" ? "hold" : "target"} ${comparator} ${formatMetric(goal.target_value)}`;

  return (
    <Link
      href={goal.href}
      aria-label={`Open ${goal.label}, current ${formatMetric(goal.current_value)}${accessibleTarget}`}
      className="group ns-card flex min-h-[250px] flex-col overflow-hidden p-5 no-underline transition-[transform,box-shadow,background-color] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--notfair-shadow-lg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("ns-dot", healthCopy.dot)} aria-hidden />
            <h3 className="m-0 truncate text-[14px] font-semibold tracking-[-0.012em] text-foreground">
              {goal.label}
            </h3>
            {goal.pinned && (
              <Pin
                aria-label="Pinned"
                className="size-3 shrink-0 text-[hsl(var(--notfair-ink-4))]"
              />
            )}
          </div>
          <p className="m-0 mt-1 truncate text-[11.5px] text-[hsl(var(--notfair-ink-4))]">
            {goal.metric_name ?? "Main metric is being defined"}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 text-[10.5px] font-medium lowercase",
            healthCopy.text,
          )}
        >
          {healthCopy.label}
        </span>
      </div>

      <div className="mt-5 flex items-end gap-2">
        <span className="text-[28px] leading-none font-semibold tabular-nums tracking-[-0.035em] text-foreground">
          {formatMetric(goal.current_value)}
        </span>
        {goal.target_value !== null && (
          <span className="pb-0.5 font-mono text-[10.5px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
            {goal.mode === "maintain" ? "hold " : "target "}
            {comparator} {formatMetric(goal.target_value)}
          </span>
        )}
      </div>

      <div className="mt-4 flex min-h-[92px] flex-1 items-center rounded-[10px] bg-[hsl(var(--notfair-surface-2)/0.46)] px-2.5 py-2">
        {hasChart ? (
          <GoalSparkline
            values={goal.snapshots}
            target={goal.target_value}
            direction={goal.metric_direction}
            width={520}
            height={76}
          />
        ) : (
          <div className="flex h-[76px] w-full items-center justify-center text-center text-[11.5px] leading-relaxed text-[hsl(var(--notfair-ink-4))]">
            {metricReady
              ? "Trend appears after the next reading"
              : goal.statement}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 font-mono text-[10.5px] text-[hsl(var(--notfair-ink-4))]">
        <span>
          {goal.tick_count} check{goal.tick_count === 1 ? "" : "s"} · {timeAgo(goal.updated_at)}
        </span>
        <ArrowUpRight className="size-3.5 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </div>

      {TERMINAL.includes(goal.status) && goal.status_reason && (
        <span className="sr-only">{goal.status_reason}</span>
      )}
    </Link>
  );
}
