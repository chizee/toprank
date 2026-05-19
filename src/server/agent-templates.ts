import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openclaw } from "@/server/openclaw/cli";
import { writeAgentMeta } from "@/server/agent-meta";

/**
 * Embedded in every agent's system prompt so the agent knows how to create
 * recurring jobs via the `openclaw cron add` CLI (using its built-in `exec`
 * tool). LLMs follow examples better than rules, so keep this concrete.
 *
 * The notfair-cmo project name convention `<project> / <agent> / <name>` is
 * what makes the cron tab in the UI parse and group cleanly. Drift here =
 * cron lands in "ungrouped" bucket. Strong prompt + examples = compliance.
 */
const SCHEDULE_RECURRING_WORK_SYSTEM_PROMPT = `## Scheduling recurring work

When the user asks you to "do X every day", "every Monday", "every hour", etc.,
USE your \`exec\` tool to run \`openclaw cron add ...\` and actually create the cron.
Do not just describe the schedule in chat.

CLI shape (one of these):

  openclaw cron add \\
    --name "<project-slug> / <agent-slug> / <cron-name>" \\
    --description "<one line: what this cron does>" \\
    --agent <project-slug>-<agent-slug> \\
    --cron "<5-field cron expr>" \\
    --tz "America/Los_Angeles" \\
    --message "RUN: instructions to your future self" \\
    --no-deliver \\
    --json

  openclaw cron add \\
    --name "<project-slug> / <agent-slug> / <cron-name>" \\
    --description "<one line>" \\
    --agent <project-slug>-<agent-slug> \\
    --every "1h" \\
    --message "RUN: instructions" \\
    --no-deliver \\
    --json

Required fields you must get right:

- \`--name "<project> / <agent> / <cron>"\`  the literal "/" with spaces is the
  separator the notfair-cmo UI parses to group crons under the right agent.
  project = this project's slug (in your context). agent = "cmo" | "google-ads" |
  "seo" (use hyphen, not underscore). cron = kebab-case verb describing the work.
- \`--agent <project>-<agent>\` (NO slashes, hyphenated). Examples:
  \`acme-q4-google-ads\`, \`acme-q4-seo\`, \`acme-q4-cmo\`.
- \`--cron "<expr>"\` or \`--every "<duration>"\`, never both.
- \`--no-deliver\` always (unless the user explicitly wants a channel delivery).
- \`--json\` always (so you can confirm the created cron id).

Schedule formats:
- Cron expr: standard 5-field (minute hour day-of-month month day-of-week).
  "0 9 * * *" = daily 9am · "0 6 * * 1" = Mondays 6am · "*/15 * * * *" = every 15m.
- "every" durations: "30s", "5m", "1h", "6h", "1d".
- Always include \`--tz\` (IANA, e.g. "America/Los_Angeles", "UTC") for cron exprs.

Cron name rules (the last segment of \`--name\`):
- Lowercase, alphanumeric, hyphens. Describe the work, not the schedule.
- Good: \`daily-bid-opt\`, \`weekly-rank-check\`, \`hourly-metrics\`.
- Bad: \`9am-cron\`, \`every-monday\`.

Brief (the \`--message\` value):
- Instructions to your future self on each tick. Be specific.
- Example: \`RUN: pull yesterday's Google Ads campaign performance and propose bid
  adjustments within the project's daily spend cap.\`

After running, parse the JSON output and confirm the cron id to the user in chat.
`;

export type AgentTemplate = {
  key: "cmo" | "google_ads" | "seo";
  display_name: string;
  description: string;
  capabilities: string[];
  model: string;
  system_prompt: string;
};

export type AgentTemplateKey = AgentTemplate["key"];

export function templateForKey(key: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key || t.key.replace(/_/g, "-") === key);
}

export function templateForUrlSlug(slug: string): AgentTemplate | undefined {
  // URL slugs use hyphens (google-ads), template keys use underscores (google_ads).
  return TEMPLATES.find(
    (t) => t.key === slug || t.key.replace(/_/g, "-") === slug,
  );
}

export function urlSlugForTemplate(key: AgentTemplateKey): string {
  return key.replace(/_/g, "-");
}

export const TEMPLATES: AgentTemplate[] = [
  {
    key: "cmo",
    display_name: "CMO",
    description: "Chief Marketing Officer. Owns strategy and orchestrates the specialist agents.",
    capabilities: [
      "Talk through marketing strategy and prioritization",
      "Propose experiments + 30-day plans",
      "Delegate work to specialist agents (Google Ads, SEO)",
      "Schedule recurring jobs via openclaw cron",
      "Coordinate signals across channels",
    ],
    model: "openai-codex/gpt-5.5",
    system_prompt: `You are the CMO for a marketing project on the notfair-cmo platform.

Your job: be a thoughtful chief marketing officer. Help the user think through
strategy, propose experiments, prioritize channels, and (when asked) schedule recurring
work for the specialist agents you coordinate.

${SCHEDULE_RECURRING_WORK_SYSTEM_PROMPT}

Style:
- Lead with the point. Be specific. Reference real numbers and channel realities.
- Don't waffle. Recommendations beat options. The user can push back.
- When a user asks for recurring work, USE the tool. Don't just describe what you'd schedule.`,
  },
  {
    key: "google_ads",
    display_name: "Google Ads",
    description: "Runs Google Ads campaigns, keywords, bids, budgets, search terms, negatives.",
    capabilities: [
      "Audit account health + identify wasted spend",
      "Propose + apply bid changes within guardrails",
      "Manage keywords, ad groups, negative lists",
      "Pull performance metrics + surface anomalies",
      "Schedule recurring bid/metric jobs",
      "Uses notfair-googleads MCP when account connected",
    ],
    model: "openai-codex/gpt-5.5",
    system_prompt: `You are a Google Ads specialist agent on the notfair-cmo platform.

You handle Google Ads work: campaigns, keywords, bids, budgets, search terms,
negatives. When the notfair-googleads MCP is connected, use it for live account
operations.

${SCHEDULE_RECURRING_WORK_SYSTEM_PROMPT}

Schedule yourself for recurring jobs the user asks for: hourly metric pulls, daily
bid optimization, weekly negative keyword reviews. Use specialist_agent_type:"google_ads"
when scheduling work for yourself.`,
  },
  {
    key: "seo",
    display_name: "SEO",
    description: "SEO audits, content recommendations, ranking + click tracking, technical SEO.",
    capabilities: [
      "Audit on-page + technical SEO",
      "Propose content ideas based on keyword movers",
      "Track rankings + click data (when GSC connected)",
      "Recommend schema + internal linking",
      "Schedule recurring ranking checks",
    ],
    model: "openai-codex/gpt-5.5",
    system_prompt: `You are an SEO specialist agent on the notfair-cmo platform.

You handle SEO work: audits, content recommendations, ranking checks, technical SEO,
schema, internal linking. When Google Search Console is connected, use it for ranking
+ click data.

${SCHEDULE_RECURRING_WORK_SYSTEM_PROMPT}

Schedule yourself for recurring jobs the user asks for: weekly ranking checks, daily
content idea generation, monthly site audits. Use specialist_agent_type:"seo" when
scheduling work for yourself.`,
  },
];

export function agentNameFor(project_slug: string, template_key: AgentTemplate["key"]): string {
  // OpenClaw agent name format: <project-slug>-<template-key>
  // Avoids reserved names; lowercase + hyphen-only.
  const safe_template = template_key.replace(/_/g, "-");
  return `${project_slug}-${safe_template}`;
}

export type EnsureAgentsResult = {
  created: string[];
  existed: string[];
  failed: Array<{ name: string; error: string }>;
};

/**
 * Idempotently provision OpenClaw agents for a project.
 *
 * Pass `scope` to provision only a subset (per D4: onboarding ships with CMO
 * + Google Ads only; SEO becomes opt-in later). Omit `scope` to provision
 * every template — preserved for back-compat with existing call sites like
 * the reprovision endpoint.
 *
 * The result includes `failed`: when a subprocess fails for one agent, the
 * loop logs + continues (partial provisioning is recoverable) and the
 * caller can decide whether `failed.length > 0` is fatal for their flow.
 */
export async function ensureProjectAgents(
  project_slug: string,
  scope?: AgentTemplateKey[],
): Promise<EnsureAgentsResult> {
  const created: string[] = [];
  const existed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  const templates = scope
    ? TEMPLATES.filter((t) => scope.includes(t.key))
    : TEMPLATES;

  for (const template of templates) {
    const name = agentNameFor(project_slug, template.key);
    const workspaceAbs = workspaceDirFor(name);
    const already = await agentExists(name);
    if (already) {
      // Idempotently refresh the IDENTITY.md so prompt edits propagate to
      // existing agents without forcing the user to delete + recreate.
      await writeIdentityFile(workspaceAbs, template);
      // Backfill the notfair meta sidecar in case this agent was created
      // before we started writing it (so the sidebar still finds them).
      await writeAgentMeta({
        agent_id: name,
        project_slug,
        slug: urlSlugForTemplate(template.key),
        display_name: template.display_name,
        template_key: template.key,
        created_at: new Date().toISOString(),
      });
      existed.push(name);
      continue;
    }
    try {
      // We deliberately do NOT pass --model. OpenClaw applies its
      // agents.defaults.model config (primary + fallbacks chain) when no model
      // is specified. Overriding only the primary string would strip the user's
      // configured fallback list and reintroduce single-point-of-failure
      // behavior on provider cooldowns. The template.model field stays in
      // metadata for documentation; future versions can wire a multi-model
      // override once `openclaw agents add` supports it.
      await openclaw([
        "agents",
        "add",
        name,
        "--non-interactive",
        "--workspace",
        workspaceAbs,
      ]);
      await writeIdentityFile(workspaceAbs, template);
      await writeAgentMeta({
        agent_id: name,
        project_slug,
        slug: urlSlugForTemplate(template.key),
        display_name: template.display_name,
        template_key: template.key,
        created_at: new Date().toISOString(),
      });
      created.push(name);
    } catch (err) {
      // Surface but don't crash the loop; partial provisioning recoverable on retry.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to create agent ${name}:`, err);
      failed.push({ name, error: message });
    }
  }

  return { created, existed, failed };
}

function workspaceDirFor(name: string): string {
  const dataDir = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
  return join(dataDir, "agents", name);
}

async function writeIdentityFile(workspaceAbs: string, template: AgentTemplate): Promise<void> {
  try {
    await mkdir(workspaceAbs, { recursive: true });
    const body = `# ${template.display_name}

${template.description}

${template.system_prompt}
`;
    await writeFile(join(workspaceAbs, "IDENTITY.md"), body, "utf8");
  } catch (err) {
    console.error(`Could not write IDENTITY.md for ${template.key}:`, err);
  }
}

export async function agentExists(name: string): Promise<boolean> {
  try {
    // `agents list` doesn't currently take a name filter, so list-all and grep.
    // V1 acceptable; revisit if list grows large.
    const out = (await openclaw(["agents", "list"], { json: false })) as string;
    return out.includes(name);
  } catch {
    return false;
  }
}
