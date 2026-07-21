import {
  listGoalActions,
  listGoalTicks,
  listGoalTicksByNumbers,
  type GoalTick,
} from "@/server/db/goals";
import { listGoalPrs, type GoalPrState } from "@/server/db/goal-prs";

/**
 * Check rows for the goal screen's diary list — each tick joined with the
 * PRs its turn registered, paged newest-first by tick_number so the list
 * can lazy-load older checks on scroll.
 */

export type CheckPr = {
  id: string;
  url: string;
  title: string;
  state: GoalPrState;
};

export type CheckRow = GoalTick & { prs: CheckPr[]; actions_count: number };

/** "action" keeps only checks that did something: recorded an action
 *  (MCP mutation, research note, decision) or registered a PR. */
export type CheckFilter = "all" | "action";

export const CHECKS_PAGE_SIZE = 10;

export function listCheckRows(
  goal_id: string,
  opts: { limit?: number; beforeTick?: number; filter?: CheckFilter } = {},
): { rows: CheckRow[]; hasMore: boolean } {
  const limit = opts.limit ?? CHECKS_PAGE_SIZE;

  const actions = listGoalActions(goal_id, 200);
  const actionCountByTick = new Map<number, number>();
  for (const a of actions) {
    if (a.tick_number == null) continue;
    actionCountByTick.set(a.tick_number, (actionCountByTick.get(a.tick_number) ?? 0) + 1);
  }

  // PRs registered before tick stamping existed resolve their check
  // through the linked action instead.
  const actionTicks = new Map(actions.map((a) => [a.id, a.tick_number]));
  const prsByTick = new Map<number, CheckPr[]>();
  for (const pr of listGoalPrs(goal_id, 100)) {
    const tickNo =
      pr.tick_number ?? (pr.action_id ? (actionTicks.get(pr.action_id) ?? null) : null);
    if (tickNo == null) continue;
    prsByTick.set(tickNo, [
      ...(prsByTick.get(tickNo) ?? []),
      { id: pr.id, url: pr.url, title: pr.title, state: pr.state },
    ]);
  }

  let page: GoalTick[];
  let hasMore: boolean;
  if (opts.filter === "action") {
    // The eligible set is small and known upfront (bounded by the action/PR
    // fetch limits above), so page over its tick numbers directly.
    const eligible = [
      ...new Set([...actionCountByTick.keys(), ...prsByTick.keys()]),
    ]
      .filter((n) => opts.beforeTick === undefined || n < opts.beforeTick)
      .sort((a, b) => b - a);
    hasMore = eligible.length > limit;
    page = listGoalTicksByNumbers(goal_id, eligible.slice(0, limit));
  } else {
    // Fetch one extra row purely to learn whether another page exists.
    const ticks = listGoalTicks(goal_id, limit + 1, opts.beforeTick);
    hasMore = ticks.length > limit;
    page = ticks.slice(0, limit);
  }

  return {
    rows: page.map((t) => ({
      ...t,
      prs: prsByTick.get(t.tick_number) ?? [],
      actions_count: actionCountByTick.get(t.tick_number) ?? 0,
    })),
    hasMore,
  };
}
