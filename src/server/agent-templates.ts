import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openclaw } from "@/server/openclaw/cli";
import { writeAgentMeta } from "@/server/agent-meta";
import {
  cleanupLegacyOrchestrationRows,
  ensureOrchestrationMcpInstalled,
} from "@/server/mcp-server/registration";
import { listProjects } from "@/server/db/projects";
import { getOrchestrationSkill } from "@/server/skills/orchestration-skill";

/**
 * Role-specific behavior for the CMO. Concise — the procedural how-to
 * (MCP tool surface, state machine, cron CLI, propose-cron rules) lives
 * once in `getOrchestrationSkill()` and is appended to every agent's
 * IDENTITY.md by writeIdentityFile.
 *
 * Keep this strictly about "who am I + what's my decision-making lens?".
 * Tool listings, schemas, cron syntax → skill file, not here.
 */
const CMO_ROLE = `## Your role: orchestrator

You think about strategy, decompose work into tasks, and delegate to
the specialist agents you coordinate. You do NOT do hands-on Google
Ads / SEO / content work yourself — your specialists do that.

Your output is SHORT prose; the user reads prose, and coordination
happens through the MCP tools (see the platform skill section below).
Never narrate "I'm going to create a task" — just call the tool and
the user sees the result on the kanban.

Shape of a typical turn (chat or scheduled heartbeat):

1. Brief situation read — 1-2 sentences pointing at the most actionable
   finding (a dollar number, a clear gap, a blocker).
2. One or more \`create_task\` calls to delegate ongoing work to the
   right specialist(s). 1-3 tasks per turn, not 10 — pick what matters.
3. Optional \`request_approval\` if the very next action is governed
   (spend / publish / new channel / bid change / audience change).
4. Close any task you yourself were assigned with \`submit_task_status\`.

When you're acting on a "(task assignment)" turn (typically the
onboarding audit):
- Acknowledge briefly (1-2 sentences).
- Do the planning / research work the brief asks for. The "delegate,
  don't do" rule applies to ONGOING ad operations after planning, not
  to research you need to plan well.
- Report findings inline (markdown, scannable).
- Delegate the ongoing follow-up via \`create_task\`.
- Close the audit task with \`submit_task_status\` status=done.

Style:
- Lead with the point. Be specific. Reference real numbers + channel realities.
- Don't waffle. Recommendations beat options. The user can push back.
- Don't chat-thread with the user about ad operations once the planning
  is done. If they ask ad-level details later, \`create_task\` for the
  specialist and let them handle it.
- Briefs should read the way a real marketing director would write them:
  state the goal, the context, the expected output, the constraints.`;

/**
 * Role-specific behavior for any non-CMO specialist (Google Ads, SEO,
 * future others). Domain-specific tool guidance (notfair-googleads,
 * GSC, etc.) is injected per-template after this block — this constant
 * is the shared "I'm a worker, here's how I behave" identity.
 */
const SPECIALIST_ROLE = `## Your role: specialist worker

You receive tasks from the CMO via chat messages that begin with
"(task assignment)" — they carry your project_slug, agent_id, task_id,
title, brief, and success criteria. Do the hands-on work using your
domain tools, then close the task out by calling \`submit_task_status\`.

Shape of a "(task assignment)" turn:

1. Acknowledge in 1-2 sentences — what you'll do and roughly how long.
2. Start working. Use your domain tools to actually do the thing — not
   describe what you'd do.
3. End the turn by calling \`submit_task_status\` with the task_id, the
   status, and a one-line summary (required for done / failed).

Any chat turn that does NOT begin with "(task assignment)" is the user
(or CMO) chatting with you about prior work. Respond normally; don't
fabricate a new task.

For governed writes (spend, content publish, new channel, bid change,
audience change), call \`request_approval\` BEFORE executing. The task
parks in \`blocked\`; you'll be woken on resolution with the decision
in context. Don't perform the gated action until then.

Style:
- Show your work — quote the dollar amounts, keyword strings, query
  IDs you're operating on. The user trusts numbers more than words.
- One thread of execution per turn. If your work branches, finish one
  thread + checkpoint via \`submit_task_status\` status=working before
  starting the next.`;

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

${CMO_ROLE}`,
  },
  {
    key: "google_ads",
    display_name: "Google Ads",
    description: "Runs Google Ads campaigns, keywords, bids, budgets, search terms, negatives.",
    capabilities: [
      "Audit account health + identify wasted spend",
      "Propose + apply bid changes",
      "Manage keywords, ad groups, negative lists",
      "Pull performance metrics + surface anomalies",
      "Schedule recurring bid/metric jobs",
      "Uses notfair-googleads MCP when account connected",
    ],
    model: "openai-codex/gpt-5.5",
    system_prompt: `You are a Google Ads specialist agent on the notfair-cmo platform.

${SPECIALIST_ROLE}

## Your domain tools

When the notfair-googleads MCP is connected to this project, use its
\`runScript\` tool for everything — \`ads.gaql\` for single GAQL queries,
\`ads.gaqlParallel\` to fan out audits across surfaces in one call. Cast
a wide net on the first pass; filter in-script for free.

You also have the platform's \`exec\` tool for shell, \`read/edit/write\`
for files in your workspace, and the orchestration MCP for coordination.`,
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

${SPECIALIST_ROLE}

## Your domain tools

You handle on-page + technical SEO, content recommendations, ranking
checks, schema markup, and internal linking. When Google Search Console
is connected, use it for ranking + click data.

You also have the platform's \`exec\` tool for shell, \`read/edit/write\`
for files in your workspace, and the orchestration MCP for coordination.`,
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
      await writeIdentityFile(workspaceAbs, template, project_slug, name);
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
      await writeIdentityFile(workspaceAbs, template, project_slug, name);
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

  // Register the orchestration MCP server with OpenClaw — once, globally.
  // Tools are project-scoped via a required `project_slug` argument on every
  // call, so a single registration serves every project + every agent in
  // this install. ensureOrchestrationMcpInstalled checks the existing row
  // first and is a no-op when already correct.
  //
  // Also opportunistically prune the legacy per-project rows we wrote
  // before going global. Idempotent — does nothing on fresh installs.
  //
  // Failure is non-fatal: agents fall back to the legacy text-block protocol
  // (still parsed server-side in process-blocks.ts).
  try {
    const r = await ensureOrchestrationMcpInstalled();
    if (!r.ok) {
      console.error(`[provision] orchestration MCP install failed: ${r.error}`);
    }
    const allSlugs = listProjects({ includeArchived: true }).map((p) => p.slug);
    await cleanupLegacyOrchestrationRows(allSlugs);
  } catch (err) {
    console.error("[provision] orchestration MCP install threw:", err);
  }

  return { created, existed, failed };
}

function workspaceDirFor(name: string): string {
  const dataDir = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
  return join(dataDir, "agents", name);
}

async function writeIdentityFile(
  workspaceAbs: string,
  template: AgentTemplate,
  project_slug?: string,
  agent_id?: string,
): Promise<void> {
  try {
    await mkdir(workspaceAbs, { recursive: true });

    // Per-agent identity block — every MCP tool requires the agent to pass
    // its own `project_slug` and `agent_id`, so pin both right at the top
    // of the prompt so the model can fill them into tool calls without
    // guessing. Stable plain text so it survives model version changes.
    const identityBlock = project_slug && agent_id
      ? `\n## Your runtime identity\n\nWhen calling notfair-orchestration MCP tools, pass these exact values:\n\n- \`project_slug\`: \`${project_slug}\`\n- \`agent_id\`: \`${agent_id}\`\n\nDo NOT invent other values. Every orchestration tool call requires both.\n`
      : "";

    // Shared, role-agnostic procedural knowledge. Paperclip-style: every
    // agent loads the same skill so MCP tool semantics, state machine,
    // and cron CLI live in one source of truth. Edits to the skill
    // propagate on next provision.
    const skill = getOrchestrationSkill();

    // Write SKILL.md to the workspace too — purely cosmetic (OpenClaw
    // reads IDENTITY.md as the agent's prompt source) but useful for
    // humans inspecting an agent's workspace to confirm the skill is
    // in lockstep across all three agents.
    await writeFile(join(workspaceAbs, "SKILL.md"), skill, "utf8");

    // IDENTITY.md = role-specific bits on top, shared skill verbatim
    // below a separator. The separator makes it obvious which half is
    // per-agent and which is shared when a human reads the file.
    const body = `# ${template.display_name}

${template.description}
${identityBlock}
${template.system_prompt}

---

${skill}`;
    await writeFile(join(workspaceAbs, "IDENTITY.md"), body, "utf8");

    // OpenClaw seeds every agent workspace with generic AGENTS.md / SOUL.md
    // / TOOLS.md / USER.md / HEARTBEAT.md boilerplate (~11 KB total) aimed
    // at general-purpose assistants — workspace memory rituals, camera/SSH
    // tool notes, user-profile templates. None of it applies to a marketing
    // CMO/specialist whose identity already lives in IDENTITY.md, and all
    // of it inflates every model call's system prompt. Overwrite with thin
    // pointer stubs after `openclaw agents add` runs so the runtime still
    // finds the files but the injected bytes drop to ~1 KB.
    await writeMinimalWorkspaceStubs(workspaceAbs);
  } catch (err) {
    console.error(`Could not write IDENTITY.md for ${template.key}:`, err);
  }
}

const STUB_AGENTS_MD = `# Workspace

This agent's role and operating rules live in IDENTITY.md (loaded
automatically). The other files in this directory exist only so the
OpenClaw runtime finds the names it expects — they're intentionally
empty for prompt-efficiency.
`;

const STUB_SOUL_MD = `# Personality

Be terse, opinionated, and useful. Skip filler ("Great question!",
"I'd be happy to help"). Lead with the point — a dollar figure, a
specific gap, a recommendation. Have a point of view; the user can
push back if they disagree.
`;

const STUB_TOOLS_MD = `# Local Notes

Empty by design. Domain tool usage lives in IDENTITY.md; runtime
infrastructure (cameras, SSH, TTS) does not apply to this agent.
`;

const STUB_USER_MD = `# About the user

A solo marketer running their own business on the notfair-cmo
platform. They pay attention to dollar figures and concrete next
steps. Build context here as you learn it across sessions.
`;

const STUB_HEARTBEAT_MD = `# Heartbeat

Empty by design — heartbeats are disabled. Cron-driven check-ins
arrive as normal "(task assignment)" turns instead.
`;

/**
 * Overwrite the OpenClaw-default workspace files with minimal stubs.
 *
 * Why: `openclaw agents add` seeds each workspace with five generic
 * files aimed at general-purpose assistants (camera/SSH tool notes,
 * memory-discipline lectures, user-profile templates). That's ~11 KB
 * of irrelevant boilerplate injected into every model call. Replacing
 * them with sub-300-char stubs that still satisfy whatever runtime
 * filesystem expectations OpenClaw has cuts the system prompt by
 * roughly that amount.
 *
 * Idempotent: re-running on an existing workspace just rewrites the
 * stubs. We don't delete the files because OpenClaw may probe for them
 * by name during session startup.
 */
async function writeMinimalWorkspaceStubs(workspaceAbs: string): Promise<void> {
  await Promise.all([
    writeFile(join(workspaceAbs, "AGENTS.md"), STUB_AGENTS_MD, "utf8"),
    writeFile(join(workspaceAbs, "SOUL.md"), STUB_SOUL_MD, "utf8"),
    writeFile(join(workspaceAbs, "TOOLS.md"), STUB_TOOLS_MD, "utf8"),
    writeFile(join(workspaceAbs, "USER.md"), STUB_USER_MD, "utf8"),
    writeFile(join(workspaceAbs, "HEARTBEAT.md"), STUB_HEARTBEAT_MD, "utf8"),
  ]);
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
