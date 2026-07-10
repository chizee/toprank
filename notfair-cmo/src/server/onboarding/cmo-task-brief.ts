/**
 * Build the brief for the CMO's project-onboarding task — the very first
 * turn for a new project. The CMO uses the optional website + codebase
 * hints to research what the company does, then writes PROJECT.md via the
 * `set_project_brief` MCP tool so every agent (CMO + specialists) shares
 * the same canonical context going forward. Audit tasks gate on this one
 * via `blocked_by_task_id`.
 */
export function buildProjectOnboardingBrief(args: {
  project_slug: string;
  project_display_name: string;
  website_url: string | null;
  codebase_path: string | null;
}): { title: string; brief: string; success_criteria: string } {
  const title = "Learn the project and write PROJECT.md";

  const hints: string[] = [];
  if (args.website_url) {
    hints.push(`- Website: ${args.website_url} — fetch + skim a few key pages (home, about, pricing if any) to understand positioning and offer.`);
  }
  if (args.codebase_path) {
    hints.push(`- Local codebase: ${args.codebase_path} — read README, package.json (or equivalent), top-level entry points. Skim only — you're looking for product shape, not a code review.`);
  }
  if (hints.length === 0) {
    hints.push("- No hints provided. Ask the user a focused question via `ask_user_question` or `add_task_comment` if you need one missing fact (target audience, what they sell). Otherwise make conservative assumptions and note them in PROJECT.md so the user can correct.");
  }

  const brief = [
    `Project: ${args.project_display_name} (${args.project_slug})`,
    "",
    "This is your very first turn for this project. Your job is to learn",
    "the company well enough that you (and every specialist you delegate",
    "to later) operates from a shared, accurate picture. Output: write",
    "PROJECT.md via the `set_project_brief` MCP tool.",
    "",
    "## 1. Gather context",
    "",
    ...hints,
    "",
    "Use the tools you have (web fetch, file read, shell exec) — there's",
    "no scraper or special infrastructure here, just you and your tools.",
    "",
    "## 2. Write PROJECT.md",
    "",
    "Call `set_project_brief` with a markdown body. Suggested sections —",
    "skip any you genuinely can't infer rather than padding:",
    "",
    "- **What we sell** — product or service in 1-2 sentences",
    "- **Who we sell to** — ICP, role, company size, geography if relevant",
    "- **Positioning / pitch** — the one-liner the homepage leads with",
    "- **Competitors / alternatives** — if visible",
    "- **Tone / voice** — quick read on how the brand writes",
    "- **Key constraints** — anything spend, compliance, or scope-related",
    "  the user mentioned",
    "",
    "Keep it tight: a CMO who knew nothing about this company should",
    "understand it in 90 seconds of reading. Quote specifics from the",
    "site/codebase rather than handwaving.",
    "",
    "Do NOT write anything about which ad platforms / accounts are",
    "connected — this task runs while the user is still connecting them,",
    "so any claim you make goes stale immediately. The platform injects",
    "live connection facts into every task assignment; PROJECT.md is for",
    "the business, not the plumbing.",
    "",
    "## 3. Close the task",
    "",
    "After `set_project_brief` returns ok, call `submit_task_status` with",
    "status=done and a one-line summary. Subsequent tasks (like the Google",
    "Ads audit) are gated on this one and auto-start the moment you close it.",
  ].join("\n");

  const success_criteria = [
    "PROJECT.md written via set_project_brief; task closed with",
    "submit_task_status status=done.",
  ].join(" ");

  return { title, brief, success_criteria };
}

/**
 * Build the brief for the CMO's first task — the audit that used to be its
 * own special-purpose code path in src/server/onboarding/audit.ts. Now the
 * audit IS a task, and it covers EVERY connected ads platform (Google,
 * Meta, X) — the kickoff message's platform-connections facts block tells
 * the CMO which ones are live. The CMO runs the probes itself via each
 * platform's MCP, writes findings inline, and delegates ongoing work via
 * the notfair-orchestration MCP tools (the same surface the CMO uses for
 * every other planning turn — see agent-templates.ts for the full teaching).
 *
 * Keeping this server-side so the wording stays in lockstep with the CMO
 * system prompt; templated rather than free-form so each new project
 * onboarding receives the same expectations.
 */
export function buildOnboardingBrief(args: {
  project_slug: string;
  project_display_name: string;
  google_ads_account_id: string | null;
}): { title: string; brief: string; success_criteria: string } {
  const account = args.google_ads_account_id ?? "(none picked — ask the user)";

  const title = "Audit the connected ad platforms and propose a starter playbook";

  const brief = [
    `Project: ${args.project_display_name} (${args.project_slug})`,
    `Google Ads account: ${account}`,
    "",
    "This is your first turn as CMO for this project. Audit EVERY",
    "connected ads platform — the \"Platform connections\" list in this",
    "assignment is ground truth: audit each ads platform it shows as",
    "connected, skip the rest. Present findings per platform, then",
    "delegate ongoing work to each platform's specialist.",
    "",
    "## 1. Probe each connected platform",
    "",
    "**Google Ads** — use the notfair-googleads MCP `runScript` tool",
    "(GAQL via `ads.gaql`, fan out with `ads.gaqlParallel`):",
    "- Customer info: status, currency, time zone",
    "- Last 30 days per enabled campaign: cost, impressions, clicks,",
    "  conversions, conversion_value",
    "- Conversion tracking: count of conversion_actions + recent_conversions",
    "- Search terms (last 30d) with cost > $10 and conversions = 0",
    "- Keywords with quality_score < 5",
    "- Campaigns within $5 of their daily budget cap",
    "",
    "**Meta Ads** — use the notfair-metaads MCP `runScript` tool",
    "(`ads.graphParallel`): campaign / ad set / ad listings with 30-day",
    "insights (spend, ROAS, CPM, CTR, frequency); flag learning-limited",
    "ad sets, creative fatigue (rising frequency + falling CTR), and",
    "audience overlap.",
    "",
    "**X Ads** — use the notfair-xads MCP tools: campaigns + line items",
    "with 30-day spend / impressions / engagement, promoted posts, and",
    "funding instruments; flag zero-spend or fully-paused accounts.",
    "",
    "## 2. Classify each platform's archetype",
    "",
    "One per audited platform:",
    "- empty — no enabled/serving campaigns",
    "- no_tracking — campaigns but no conversion tracking",
    "- low_volume — too little traffic/spend to optimize (< ~50 clicks or",
    "  < ~$200 / month)",
    "- active — meaningful data to optimize on",
    "",
    "## 3. Report findings to the user (in this reply)",
    "",
    "Markdown, scannable, one section per audited platform (skip findings",
    "that don't exist, don't pad):",
    "- **Snapshot** — 1-2 sentences naming the archetype + spend",
    "- **Wasted spend** — top gaps with $ amounts (search terms on Google;",
    "  fatigued creatives / overlapping audiences on Meta; dead line items on X)",
    "- **Quality issues** — low QS keywords, learning-limited ad sets, etc.",
    "- **Budget pacing** — campaigns hitting cap",
    "- **Next steps** — up to 3 concrete actions per platform, tailored to",
    "  its archetype",
    "",
    "Lead with the dollar figure or the most actionable finding. Don't ask",
    '"want me to..." — you\'re an orchestrator; delegate, don\'t advise.',
    "",
    "## 4. Delegate the ongoing work",
    "",
    "For each Next Step that's actionable + repeatable, delegate it to",
    "THAT platform's specialist (google_ads / meta_ads / x_ads — use",
    "`list_project_agents` to get exact agent ids). Include the cadence in",
    "the brief itself (\"daily 9am Pacific anomaly check on enabled",
    "campaigns\", \"weekly Monday search-term review\", etc.) — the",
    "specialist will schedule its own cron.",
    "",
    "ONLY IF you actually delegated tasks, close with a one-line tail",
    "naming which specialists got work (\"Handed these to your Google Ads",
    'and X Ads specialists — open their Tasks tabs to follow along.").',
    "When you skipped delegation for a platform (e.g. empty account), say",
    "what would unlock it instead — don't claim a handoff that didn't happen.",
  ].join("\n");

  const success_criteria = [
    "Findings reported per connected ads platform as inline markdown;",
    "ongoing work delegated to each platform's specialist (skip a",
    "platform's delegation when its archetype = empty); this audit task",
    "marked done.",
  ].join(" ");

  return { title, brief, success_criteria };
}
