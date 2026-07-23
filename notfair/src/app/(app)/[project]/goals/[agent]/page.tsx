import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import {
  getGoalForAgent,
  getLatestGoalForAgent,
  isGoalArchived,
  listGoalActions,
  listOpenGoalActions,
  listUserActionRequests,
  loggedSpendTotal,
  listGoalLearnings,
  listGoalTicks,
  listMetricSnapshots,
  isTargetMet,
  USER_ACTION_PREFIX,
  type Goal,
} from "@/server/db/goals";
import { GoalNeedsYouDialog, type NeedsYouItem } from "@/components/goal-needs-you";
import { listCheckRows } from "@/server/goals/checks";
import {
  listSessionsForAgent,
  pickLatestChatSession,
} from "@/server/sessions/view";
import { readTranscriptTail } from "@/server/sessions/transcript-tail";
import { getMcpCatalog } from "@/server/mcp-catalog";
import { DEFAULT_HARNESS_ADAPTER, requireAdapter } from "@/server/adapters/registry";
import { projectHref } from "@/lib/project-href";
import { goalLabel } from "@/lib/goal-label";
import { formatMetric } from "@/lib/format-metric";
import { GoalMemoryDialog } from "@/components/goal-memory-dialog";
import { Markdown } from "@/components/markdown";
import { GoalContextDialog } from "@/components/goal-context-dialog";
import { cadenceLabel } from "@/lib/goal-cadence";
import { cn } from "@/lib/utils";
import { LiveTranscript } from "@/components/live-transcript";
import { GoalControls } from "@/components/goal-controls";
import { GoalAutoRefresh } from "@/components/goal-auto-refresh";
import { GoalProgressChart } from "@/components/goal-progress-chart";
import { GoalMetricCard, type MetricVariant } from "@/components/goal-metric-card";
import { GoalChecksStrip } from "@/components/goal-checks-strip";
import { GoalChecksList } from "@/components/goal-checks-list";
import { RailSection } from "@/components/rail-section";
import { listGoalPrs } from "@/server/db/goal-prs";
import {
  listSupportMetrics,
  listSupportMetricSnapshots,
  type GoalSupportMetric,
} from "@/server/db/goal-support-metrics";
import { MetricMethodDialog } from "@/components/metric-method-dialog";
import { timeUntil } from "@/lib/time-ago";
import { GoalMovesDialog } from "@/components/goal-moves-dialog";
import { type MoveRow } from "@/components/goal-moves";
import { GoalPrsDialog, type PrRow } from "@/components/goal-prs-dialog";
import { maybeSyncGoalPrs } from "@/server/goals/pr-sync";
import { buildCheckSquares, currentStreak } from "@/lib/goal-streak";
import { GoalCompletionDialog } from "@/components/goal-completion-dialog";

export const dynamic = "force-dynamic";

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

/** Local wall-clock for a timestamp: "7:00 PM" today, "Jul 25, 9:00 AM" beyond. */
function fmtClock(iso: string): string {
  const date = new Date(iso);
  const withinDay = Math.abs(date.getTime() - Date.now()) < 86_400_000;
  return date.toLocaleString(
    [],
    withinDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
}



const STATUS_CHIP: Record<Goal["status"], string> = {
  intake: "setting up",
  proposed: "confirm the plan",
  active: "running",
  paused: "paused",
  achieved: "achieved",
  failed: "failed",
  killed: "closed",
};

/**
 * THE goal screen — everything about one goal on a single page. Chat is
 * the primary surface (goals are defined and steered in conversation);
 * the right rail is the loop dashboard: metric hero, supporting metrics
 * on the same chart grammar, check diary. No tabs, no thread management —
 * one goal, one conversation, one screen.
 */
export default async function GoalPage({
  params,
}: {
  params: Promise<{ agent: string; project: string }>;
}) {
  const { agent: agentSlug, project: slug } = await params;
  const project = getProject(slug);
  if (!project || project.archived_at) notFound();
  const resolved = await resolveAgentBySlug(slug, agentSlug);
  if (!resolved) notFound();

  const goal =
    getGoalForAgent(resolved.agent_id) ?? getLatestGoalForAgent(resolved.agent_id);
  if (!goal) notFound();

  // One conversation per goal: the newest chat-origin session (the intake
  // kickoff creates it), or "main" for a fresh fallback.
  const sessions = listSessionsForAgent(slug, resolved.agent_id);
  const threadId = pickLatestChatSession(sessions)?.sessionId ?? "main";
  const existing = sessions.find((s) => s.sessionId === threadId);
  const { events: initialEvents, cursor: initialCursor } = readTranscriptTail(
    slug,
    resolved.agent_id,
    threadId,
    0,
  );
  const modelOptions = await requireAdapter(
    project.harness_adapter ?? DEFAULT_HARNESS_ADAPTER,
  ).listModels();
  const mcpCatalog = getMcpCatalog(slug).map((m) => ({
    key: m.key,
    display_name: m.display_name,
    resource_url: m.resource_url,
  }));

  const live = goal.status === "intake" || goal.status === "proposed" || goal.status === "active" || goal.status === "paused";
  const achievementArchived =
    goal.status === "achieved" ? isGoalArchived(goal.id) : false;
  const learnings = listGoalLearnings(goal.id, 100);

  // Header dialogs: the moves journal (every open action, whatever its
  // stage) and open PRs. Kick a background GitHub sync when PR rows look
  // stale — the page's auto-refresh poll picks up the fresh state.
  const moveRows: MoveRow[] = listOpenGoalActions(goal.id).map((a) => ({
    action_id: a.id,
    kind: a.kind,
    description: a.description,
    resources: JSON.parse(a.resources_touched_json || "[]") as string[],
    made_at: a.created_at,
    observe_until: a.review_after,
  }));
  // Open escalations only the user can resolve — the amber header button.
  const needsYou: NeedsYouItem[] = listUserActionRequests(goal.id).map((a) => ({
    action_id: a.id,
    ask: a.description
      .slice(USER_ACTION_PREFIX.length)
      .replace(/^[\s:—–-]+/, ""),
    tick_number: a.tick_number,
    raised_at: a.created_at,
  }));
  const openPrs = listGoalPrs(goal.id, 100).filter((pr) => pr.state === "open");
  if (openPrs.length > 0) maybeSyncGoalPrs(goal.id);
  const prRows: PrRow[] = openPrs.map((pr) => ({
    id: pr.id,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    review_decision: pr.review_decision,
    comment_count: pr.comment_count,
    is_draft: Boolean(pr.is_draft),
    branch: pr.branch,
    created_at: pr.created_at,
    sync_error: pr.sync_error,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Every pre-terminal state changes server-side via agent tool
          calls: intake verifies the metric (→ proposed), and the user's
          confirmation in chat lands via propose_target (→ active, first
          check running). Without polling, the rail keeps showing the
          previous stage until a manual reload. */}
      {(goal.status === "intake" ||
        goal.status === "proposed" ||
        goal.status === "active") && <GoalAutoRefresh intervalMs={8000} />}

      {/* Header: the goal is the title. */}
      <header className="flex min-w-0 flex-wrap items-center gap-2 py-2.5 pr-3 pl-16 sm:pr-5 md:pl-5 lg:flex-nowrap lg:gap-3">
        <span className="ns-tag-mono shrink-0">{STATUS_CHIP[goal.status]}</span>
        <h1 className="m-0 min-w-0 flex-1 truncate text-[14px] font-semibold">
          {goalLabel(goal)}
        </h1>
        <div className="order-last flex w-full shrink-0 items-center justify-end gap-2 lg:order-none lg:ml-auto lg:w-auto">
          {/* Escalations stay visible at every width — they're the one
              header item that is the user's job, not the agent's. */}
          <GoalNeedsYouDialog
            items={needsYou}
            projectSlug={slug}
            agentSlug={agentSlug}
          />
          <div className="hidden lg:contents">
            <GoalContextDialog
              projectSlug={slug}
              agentSlug={agentSlug}
              agentId={resolved.agent_id}
              threadId={threadId}
              models={modelOptions.map((m) => ({
                value: m.value,
                label: m.label,
                context_window: m.context_window,
                is_default: m.is_default,
              }))}
            />
            <GoalMemoryDialog
              entries={learnings.map((l) => ({
                id: l.id,
                body: l.body,
                confidence: l.confidence,
                created_at: l.created_at,
              }))}
            />
            <GoalMovesDialog moves={moveRows} nextCheckAt={goal.next_tick_at} />
            <GoalPrsDialog prs={prRows} />
          </div>
          {live && (
            <GoalControls
              goalId={goal.id}
              status={goal.status as "intake" | "proposed" | "active" | "paused"}
            />
          )}
          {goal.status === "achieved" && !achievementArchived && (
            <GoalCompletionDialog
              goalId={goal.id}
              label={goalLabel(goal)}
              metricName={goal.metric_name}
              currentValue={goal.current_value}
              targetValue={goal.target_value}
              metricDirection={goal.metric_direction}
              completionReason={goal.status_reason}
              completedAt={goal.updated_at}
              trigger={
                <button
                  type="button"
                  className="ns-chip ns-completed-badge bg-[hsl(var(--notfair-accent-soft))] font-medium text-[hsl(var(--notfair-accent))] shadow-[inset_0_0_0_1px_hsl(var(--notfair-accent-border))] hover:text-[hsl(var(--notfair-accent))]"
                  aria-label="Celebrate this completed goal"
                >
                  <Sparkles aria-hidden />
                  Celebrate
                </button>
              }
            />
          )}
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Chat — the primary surface. */}
        <section className="flex min-w-0 flex-1 flex-col">
          <LiveTranscript
            key={threadId}
            projectSlug={slug}
            agentSlug={agentSlug}
            agentDisplayName={goalLabel(goal)}
            threadId={threadId}
            initialEvents={initialEvents}
            initialCursor={initialCursor}
            mcpCatalog={mcpCatalog}
            modelOptions={modelOptions}
          />
        </section>

        {/* The loop dashboard rail — metric hero, supporting metrics on the
            same chart grammar, check diary. Wide enough for real charts. */}
        <aside className="hidden w-[440px] shrink-0 overflow-y-auto bg-[hsl(var(--notfair-surface-2)/0.4)] px-4 py-4 xl:block">
          <div className="flex flex-col gap-5">
            <GoalDashboard slug={slug} agentSlug={agentSlug} goal={goal} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function GoalDashboard({
  slug,
  agentSlug,
  goal,
}: {
  slug: string;
  agentSlug: string;
  goal: Goal;
}) {
  const snapshots = listMetricSnapshots(goal.id, 400);
  const ticks = listGoalTicks(goal.id, 60);
  const allActions = listGoalActions(goal.id, 100);
  const targetMet = isTargetMet(goal);
  const tickRunning = ticks.some((t) => t.status === "running");
  const supportMetrics = listSupportMetrics(goal.id);
  // First diary page for the lazy checks list; older pages stream in on
  // scroll via loadMoreGoalChecksAction.
  const { rows: checkRows, hasMore: checksHaveMore } = listCheckRows(goal.id);

  // Chart data — plain-JSON props for the client component.
  const chartPoints = snapshots.map((sn) => ({
    t: Date.parse(sn.created_at),
    v: sn.value,
    source: sn.source,
  }));
  const chartActions = allActions
    .filter((a) => a.kind === "mutation")
    .map((a) => ({
      t: Date.parse(a.created_at),
      kind: a.kind,
      label: a.description,
      expected: a.expected_effect,
      observed: a.observed_outcome,
      reviewUntil:
        a.status === "open" && a.review_after ? Date.parse(a.review_after) : null,
    }));
  const chartFailures = ticks
    .filter((t) => t.metric_error || t.status === "failed")
    .map((t) => ({
      t: Date.parse(t.started_at),
      error: t.metric_error ?? t.summary ?? "check failed",
    }));
  const mutationTicks = new Set(
    allActions.filter((a) => a.kind === "mutation").map((a) => a.tick_number),
  );
  // One metric, several windows: supporting metrics whose base name matches
  // the goal metric fold into the hero card's window switcher; anything
  // else remains a genuine supporting metric below.
  const baseName = (name: string | null) =>
    (name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const windowLabel = (name: string | null) => {
    const paren = /\(([^)]*)\)\s*$/.exec(name ?? "")?.[1] ?? "";
    return paren.split(/[\s,]+/).filter(Boolean).pop() ?? "now";
  };
  const supportRows = supportMetrics.map((metric) => ({
    metric,
    points: listSupportMetricSnapshots(metric.id, 400).map((sn) => ({
      t: Date.parse(sn.created_at),
      v: sn.value,
      source: sn.source,
    })),
  }));
  const isWindowVariant = ({ metric }: (typeof supportRows)[number]) =>
    baseName(metric.name) === baseName(goal.metric_name);
  const extraSupports = supportRows.filter((row) => !isWindowVariant(row));
  const metricVariants: MetricVariant[] = [
    {
      key: "goal",
      label: windowLabel(goal.metric_name),
      name: goal.metric_name ?? "Metric",
      current: goal.current_value,
      baseline: goal.baseline_value,
      target: goal.target_value,
      direction: goal.metric_direction,
      sourceKey: goal.metric_source_key,
      sourceTool: goal.metric_source_tool,
      argsJson: goal.metric_source_args_json,
      points: chartPoints,
    },
    ...supportRows.filter(isWindowVariant).map(({ metric, points }) => ({
      key: metric.id,
      label: windowLabel(metric.name),
      name: metric.name,
      current: metric.current_value,
      baseline: metric.baseline_value,
      target: null,
      direction: metric.direction,
      sourceKey: metric.source_key,
      sourceTool: metric.source_tool,
      argsJson: metric.source_args_json,
      points,
    })),
  ];

  const squares = buildCheckSquares(
    ticks
      .filter((t) => t.status !== "running" && t.trigger_kind !== "intake")
      .map((t) => ({
        tick_number: t.tick_number,
        started_at: t.started_at,
        metric_value: t.metric_value,
        status: t.status,
        acted: mutationTicks.has(t.tick_number),
      })),
    goal.target_value,
    goal.metric_direction,
  );
  const streak = currentStreak(squares);

  return (
    <>
      <RailSection title="Goal">
        <p className="m-0 text-[12.5px] leading-relaxed text-[hsl(var(--notfair-ink-3))]">
          “{goal.statement}”
        </p>
      </RailSection>

      {/* Lifecycle-specific card */}
      {goal.status === "intake" && (
        <RailSection title="Main metric">
          <RailCard>
            <p className="m-0 text-[12.5px] leading-relaxed">
              The agent is working out how to <b>measure</b> this — watch the
              chat. It will verify a metric, show you the baseline, and propose
              a plan. Nothing touches your account yet.
            </p>
          </RailCard>
        </RailSection>
      )}

      {goal.status === "proposed" && (
        <RailSection title="Main metric">
          <RailCard>
            <p className="m-0 text-[12.5px] leading-relaxed">
              Baseline <b className="tabular-nums">{formatMetric(goal.baseline_value)}</b>,
              verified against{" "}
              <span className="font-mono text-[11px]">{goal.metric_source_key}</span>{" "}
              <MetricMethodDialog
                name={goal.metric_name ?? "Metric"}
                sourceKey={goal.metric_source_key}
                sourceTool={goal.metric_source_tool}
                argsJson={goal.metric_source_args_json}
                direction={goal.metric_direction}
              />
              . Agree the target in chat — the moment you confirm, the loop
              starts and the first check runs.
            </p>
          </RailCard>
        </RailSection>
      )}

      {(goal.status === "active" ||
        goal.status === "paused" ||
        goal.status === "achieved" ||
        goal.status === "failed" ||
        goal.status === "killed") && (
        <>
          <RailSection title="Main metric">
            <GoalMetricCard
              variants={metricVariants}
              mode={goal.mode}
              badges={
                <>
                  {targetMet && (
                    <span key="state" className="ns-tag">
                      {goal.mode === "maintain" ? "holding" : "target met"}
                    </span>
                  )}
                  {tickRunning && (
                    <span key="checking" className="ns-tag">
                      checking…
                    </span>
                  )}
                </>
              }
              strip={
                goal.mode === "maintain" ? (
                  <div key="strip" className="mt-3">
                    <GoalChecksStrip squares={squares} streak={streak} />
                  </div>
                ) : undefined
              }
              footer={
                <>
                  <p
                    key="cadence"
                    className="mt-1.5 mb-0 text-[11px] leading-relaxed text-[hsl(var(--notfair-ink-4))]"
                  >
                    {cadenceLabel(goal.cadence_cron)} · {goal.tick_count} check
                    {goal.tick_count === 1 ? "" : "s"} so far
                    {goal.spend_envelope_usd !== null &&
                      ` · spent $${loggedSpendTotal(goal.id)} of $${goal.spend_envelope_usd}`}
                  </p>
                  {goal.status_reason &&
                    (goal.status === "achieved" || goal.status === "failed" || goal.status === "killed") && (
                      <Markdown
                        key="reason"
                        className="mt-2 text-[12px] leading-relaxed text-[hsl(var(--notfair-ink-3))] [&_p]:m-0"
                      >
                        {goal.status_reason}
                      </Markdown>
                    )}
                </>
              }
              actions={chartActions}
              failures={chartFailures}
              deadline={goal.deadline ? Date.parse(goal.deadline) : null}
            />
          </RailSection>

          {extraSupports.length > 0 && (
            <RailSection title="Supporting metrics" count={extraSupports.length}>
              <div className="flex flex-col gap-4">
                {extraSupports.map(({ metric }) => (
                  <SupportMetricItem key={metric.id} metric={metric} />
                ))}
              </div>
            </RailSection>
          )}

          <RailSection
            title="Checks"
            count={goal.tick_count}
            meta={
              goal.status === "active"
                ? tickRunning
                  ? "running now"
                  : goal.next_tick_at
                    ? (
                        <span title={`Scheduled for ${fmtClock(goal.next_tick_at)}`}>
                          next check {timeUntil(goal.next_tick_at)}
                        </span>
                      )
                    : "next check —"
                : undefined
            }
          >
            {checkRows.length === 0 ? (
              <p className="m-0 text-[12px] text-[hsl(var(--notfair-ink-4))]">
                None yet — the first runs{" "}
                {goal.next_tick_at
                  ? `${timeUntil(goal.next_tick_at)} (${fmtClock(goal.next_tick_at)})`
                  : `at ${fmtDate(goal.next_tick_at)}`}
                .
              </p>
            ) : (
              <GoalChecksList
                slug={slug}
                agentSlug={agentSlug}
                goalId={goal.id}
                initialRows={checkRows}
                initialHasMore={checksHaveMore}
              />
            )}
          </RailSection>

        </>
      )}
    </>
  );
}

function RailCard({ children }: { children: React.ReactNode }) {
  return <div className="ns-card p-3.5">{children}</div>;
}

/** One supporting metric — the SAME card grammar as the main metric:
 *  name + ⓘ header, big current value with baseline context, and the
 *  same time chart (no target line: supports have no target). */
function SupportMetricItem({ metric }: { metric: GoalSupportMetric }) {
  const points = listSupportMetricSnapshots(metric.id, 400).map((sn) => ({
    t: Date.parse(sn.created_at),
    v: sn.value,
    source: sn.source,
  }));
  return (
    <div className="ns-card p-3.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[hsl(var(--notfair-ink-4))]">
          <span className="truncate">{metric.name}</span>
          <MetricMethodDialog
            name={metric.name}
            sourceKey={metric.source_key}
            sourceTool={metric.source_tool}
            argsJson={metric.source_args_json}
            direction={metric.direction}
          />
        </span>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-xl font-semibold tabular-nums">
          {formatMetric(metric.current_value)}
        </span>
        <span className="text-[11.5px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
          baseline {formatMetric(metric.baseline_value)}
        </span>
      </div>
      {points.length >= 2 && (
        <div className="mt-3">
          <GoalProgressChart
            points={points}
            actions={[]}
            failures={[]}
            target={null}
            baseline={metric.baseline_value}
            deadline={null}
          />
        </div>
      )}
    </div>
  );
}
