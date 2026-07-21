import {
  listGoalActionBadges,
  listGoalActions,
  listGoalTicks,
  listGoalTicksByNumbers,
  listTickToolCalls,
  type GoalTick,
} from "@/server/db/goals";
import { listGoalPrs, type GoalPrState } from "@/server/db/goal-prs";

/**
 * Check rows for the goal screen's diary list — each tick joined with the
 * PRs its turn registered and the writes its session performed, paged
 * newest-first by tick_number so the list can lazy-load older checks on
 * scroll.
 */

export type CheckPr = {
  id: string;
  url: string;
  title: string;
  state: GoalPrState;
};

/** One kind of modification a check made, e.g. "Campaign budget updated". */
export type CheckWrite = { label: string; count: number };

export type CheckRow = GoalTick & { prs: CheckPr[]; writes: CheckWrite[] };

/** "action" keeps only checks that modified something: performed a
 *  platform/goal write or registered a PR. Read-only checks are hidden. */
export type CheckFilter = "all" | "action";

export const CHECKS_PAGE_SIZE = 10;

/**
 * Verb-first tool-name conventions across the MCP catalog and the goal
 * tools (`updateCampaignBudget`, `pause_keyword`, `amend_goal`) let the
 * leading token classify writes. Only these verbs badge; read verbs
 * (get/list/run/search…) and diary bookkeeping (log/review/propose/
 * register…) fall through to null.
 */
const WRITE_VERB_PAST: Record<string, string> = {
  // NotFair catalog conventions (Google Ads, Meta Ads, goal tools).
  create: "created",
  add: "added",
  update: "updated",
  set: "set",
  amend: "updated",
  manage: "updated",
  delete: "deleted",
  remove: "removed",
  pause: "paused",
  enable: "enabled",
  resume: "resumed",
  rename: "renamed",
  upload: "uploaded",
  move: "moved",
  link: "linked",
  unlink: "unlinked",
  exclude: "excluded",
  include: "included",
  graduate: "graduated",
  promote: "promoted",
  end: "ended",
  schedule: "scheduled",
  replace: "replaced",
  mutate: "mutated",
  // Common write verbs across third-party MCP servers.
  send: "sent",
  post: "posted",
  publish: "published",
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  archive: "archived",
  cancel: "canceled",
  close: "closed",
  merge: "merged",
  apply: "applied",
  insert: "inserted",
  write: "written",
  patch: "patched",
  toggle: "toggled",
  assign: "assigned",
  revoke: "revoked",
  grant: "granted",
  attach: "attached",
  detach: "detached",
  sync: "synced",
  import: "imported",
  deploy: "deployed",
  save: "saved",
  restore: "restored",
  invite: "invited",
  register: "registered",
};

/**
 * Map a raw harness tool name to a short "what changed" badge label, or
 * null when the call isn't a write worth badging. PR creation and
 * registration return null — the PR pill already covers those.
 *
 *   `notfair_x__notfair_googleads.updateCampaignBudget` → "Campaign budget updated"
 *   `mcp__NotFair-GoogleAds__pauseKeyword`              → "Keyword paused"
 *   `notfair_x__notfair_goals.amend_goal`               → "Goal updated"
 *   `...listKeywords` / `...log_goal_action` / `shell`  → null
 */
export function writeBadgeForTool(name: string): string | null {
  if (!name) return null;
  // Only namespaced MCP tools qualify. Bare harness built-ins (`shell`,
  // `Write`, `Edit`) are workspace file/command work, not platform writes —
  // code changes surface through the PR pill instead.
  if (!/__|\./.test(name)) return null;
  // Strip both namespace conventions, keeping only the action name.
  let action = name;
  for (const sep of ["__", "."]) {
    const idx = action.lastIndexOf(sep);
    if (idx >= 0 && action.slice(idx + sep.length)) action = action.slice(idx + sep.length);
  }
  if (/pull_?request/i.test(action)) return null;
  // camelCase / snake_case → lowercase tokens.
  let tokens = action
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  if (tokens[0] === "bulk") tokens = tokens.slice(1);
  if (tokens[0] === "run" && tokens[1] === "mutation") return "Mutation script ran";
  const past = WRITE_VERB_PAST[tokens[0] ?? ""];
  if (!past) return null;
  const obj = tokens.slice(1).join(" ");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // Bare-verb tools (`mutate`, `deploy`) badge as just the past tense;
  // prepositional names (`deploy_to_vercel`) keep verb-first order.
  if (!obj) return cap(past);
  if (/^(to|from|into|in|for|with) /.test(obj)) return `${cap(past)} ${obj}`;
  return `${cap(obj)} ${past}`;
}

/**
 * tick_number → deduped write badges (first-seen order, with counts).
 *
 * Two sources, agent-first: badges the agent wrote via log_goal_action's
 * `action_badge` are authoritative for their check — the agent knows what
 * it changed regardless of tool naming. Checks with no agent badge fall
 * back to classifying the session's tool calls by name, so history and
 * forgetful turns still badge. PR-ish agent badges are dropped — the PR
 * pill already covers those.
 */
function collectWritesByTick(goal_id: string): Map<number, CheckWrite[]> {
  const agent = new Map<number, Map<string, CheckWrite>>();
  for (const { tick_number, badge } of listGoalActionBadges(goal_id)) {
    if (tick_number == null || /pull.?request|\bpr\b/i.test(badge)) continue;
    tally(agent, tick_number, badge);
  }

  const derived = new Map<number, Map<string, CheckWrite>>();
  for (const call of listTickToolCalls(goal_id)) {
    if (agent.has(call.tick_number)) continue;
    const label = writeBadgeForTool(call.name);
    if (label) tally(derived, call.tick_number, label);
  }

  return new Map(
    [...agent, ...derived].map(([tick, labels]) => [tick, [...labels.values()]]),
  );
}

function tally(
  acc: Map<number, Map<string, CheckWrite>>,
  tick: number,
  label: string,
): void {
  const labels = acc.get(tick) ?? new Map<string, CheckWrite>();
  const entry = labels.get(label);
  if (entry) entry.count += 1;
  else labels.set(label, { label, count: 1 });
  acc.set(tick, labels);
}

export function listCheckRows(
  goal_id: string,
  opts: { limit?: number; beforeTick?: number; filter?: CheckFilter } = {},
): { rows: CheckRow[]; hasMore: boolean } {
  const limit = opts.limit ?? CHECKS_PAGE_SIZE;

  const writesByTick = collectWritesByTick(goal_id);

  // PRs registered before tick stamping existed resolve their check
  // through the linked action instead.
  const actionTicks = new Map(
    listGoalActions(goal_id, 200).map((a) => [a.id, a.tick_number]),
  );
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
    // The eligible set is small and known upfront, so page over its tick
    // numbers directly.
    const eligible = [...new Set([...writesByTick.keys(), ...prsByTick.keys()])]
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
      writes: writesByTick.get(t.tick_number) ?? [],
    })),
    hasMore,
  };
}
