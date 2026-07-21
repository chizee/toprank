"use client";

import { useState } from "react";
import { GoalProgressChart, type ChartAction, type ChartFailure, type ChartPoint } from "@/components/goal-progress-chart";
import { MetricMethodDialog } from "@/components/metric-method-dialog";
import { formatMetric } from "@/lib/format-metric";
import { cn } from "@/lib/utils";

export type MetricVariant = {
  key: string;
  /** Switcher label, e.g. "1h", "24h", "7d". */
  label: string;
  name: string;
  current: number | null;
  baseline: number | null;
  /** Only the goal's own window has a target; context windows pass null. */
  target: number | null;
  direction: "increase" | "decrease" | null;
  sourceKey: string | null;
  sourceTool: string | null;
  argsJson: string | null;
  points: ChartPoint[];
};

/**
 * The metric hero with a time-window switcher. One metric, one card:
 * the goal's scoring window plus its context windows (24h, 7d) flip in
 * place instead of stacking as separate "supporting metrics". The first
 * variant is the goal's own — it carries the target line and is what
 * checks are scored against; the switcher resets to it per page load.
 * Badges, the checks strip, and the cadence footer describe the LOOP,
 * not the window, so they render unchanged whichever window shows.
 */
export function GoalMetricCard({
  variants,
  mode,
  badges,
  strip,
  footer,
  actions,
  failures,
  deadline,
}: {
  variants: MetricVariant[];
  mode: "achieve" | "maintain";
  badges?: React.ReactNode;
  strip?: React.ReactNode;
  footer?: React.ReactNode;
  actions: ChartAction[];
  failures: ChartFailure[];
  deadline: number | null;
}) {
  const [key, setKey] = useState(variants[0]!.key);
  const active = variants.find((v) => v.key === key) ?? variants[0]!;

  return (
    <div className="ns-card p-3.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[hsl(var(--notfair-ink-4))]">
          <span className="truncate">{active.name}</span>
          <MetricMethodDialog
            name={active.name}
            sourceKey={active.sourceKey}
            sourceTool={active.sourceTool}
            argsJson={active.argsJson}
            direction={active.direction}
          />
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {badges}
          {variants.length > 1 && (
            <span
              role="tablist"
              aria-label="Metric time window"
              className="flex gap-0.5 rounded-md bg-[hsl(var(--notfair-surface-2))] p-0.5"
            >
              {variants.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={v.key === active.key}
                  className={cn(
                    "rounded-[5px] px-2 py-0.5 text-[11px] tabular-nums transition-colors",
                    v.key === active.key
                      ? "bg-[hsl(var(--card))] font-medium text-[hsl(var(--notfair-ink))] shadow-sm"
                      : "text-[hsl(var(--notfair-ink-4))] hover:text-[hsl(var(--notfair-ink-2))]",
                  )}
                  onClick={() => setKey(v.key)}
                >
                  {v.label}
                </button>
              ))}
            </span>
          )}
        </span>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold tabular-nums">
          {formatMetric(active.current)}
        </span>
        <span className="text-[11.5px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
          {active.target !== null &&
            `target ${formatMetric(active.target)}${mode === "maintain" ? " (hold)" : ""} · `}
          baseline {formatMetric(active.baseline)}
        </span>
      </div>

      {strip}

      <div className="mt-3">
        <GoalProgressChart
          points={active.points}
          actions={actions}
          failures={failures}
          target={active.target}
          baseline={active.baseline}
          deadline={deadline}
        />
      </div>

      {footer}
    </div>
  );
}
