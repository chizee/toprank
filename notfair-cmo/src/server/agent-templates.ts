import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openclaw } from "@/server/openclaw/cli";
import { listAllAgents } from "@/server/openclaw/gateway-rpc";
import {
  initProgress,
  updateStep,
  type ProgressStep,
} from "@/server/onboarding/provisioning-progress";
import { readAgentMeta, writeAgentMeta } from "@/server/agent-meta";
import {
  cleanupLegacyOrchestrationRows,
  ensureOrchestrationMcpInstalled,
} from "@/server/mcp-server/registration";
import { listProjects } from "@/server/db/projects";
import { getOrchestrationSkill } from "@/server/skills/orchestration-skill";
import { readProjectBrief } from "@/server/onboarding/project-brief";

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
  /**
   * Label for the ROLE this template represents (e.g. "CMO", "Google
   * Ads"). Used in the sidebar role pill + anywhere the UI says
   * "what kind of agent is this". Distinct from the agent's PERSONAL
   * name (e.g. "Greg"); the personal name lives on AgentMeta.
   */
  display_name: string;
  /**
   * Suggested personal name pre-filled into the onboarding form when
   * the user provisions this template. Short + memorable so the
   * sidebar reads like a team of named colleagues rather than a roster
   * of job titles. Users can override during onboarding; the choice
   * becomes immutable once the agent is created.
   */
  default_name: string;
  description: string;
  capabilities: string[];
  model: string;
  system_prompt: string;
  /**
   * True when this template is included in the default onboarding bundle
   * (provisioned on project create + always shown in the sidebar even
   * before disk writes finish). False = opt-in: the template exists for
   * future use, but nothing surfaces it until something explicitly
   * provisions a clone of it for a project.
   */
  default_onboarding: boolean;
};

export type AgentTemplateKey = AgentTemplate["key"];

/**
 * Subset of TEMPLATES included in the default onboarding bundle. Single
 * source of truth for "which agents does a freshly-created project get?".
 * Used by createProject actions to scope ensureProjectAgents and by
 * listProjectAgents to decide which template entries to synthesize as
 * placeholders before disk-overlay merges in.
 */
export const DEFAULT_ONBOARDING_TEMPLATE_KEYS: AgentTemplateKey[] = ["cmo", "google_ads"];

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
    default_name: "Greg",
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
    default_onboarding: true,
  },
  {
    key: "google_ads",
    display_name: "Google Ads",
    default_name: "Ana",
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
    default_onboarding: true,
  },
  {
    key: "seo",
    display_name: "SEO",
    default_name: "Sam",
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
    default_onboarding: false,
  },
];

export function agentNameFor(
  project_slug: string,
  template_key: AgentTemplate["key"],
  name: string,
): string {
  // OpenClaw agent name format: <project-slug>-<role>-<slugified-name>
  // (e.g. `acme-cmo-greg`). Encoding the personal name in the backend
  // id keeps the agent_id and URL slug in lockstep: the URL slug is
  // exactly `<role>-<slugified-name>`, the project-prefix dropped.
  return `${project_slug}-${agentUrlSlug(template_key, name)}`;
}

/**
 * URL slug for a template agent — `<role>-<slugified-name>`. The personal
 * name is the user-chosen "Greg" / "Ana" etc; the role is the template
 * key (cmo, google_ads → google-ads). Examples:
 *
 *   role=cmo,        name=Greg      → "cmo-greg"
 *   role=google_ads, name="Ana Q4"  → "google-ads-ana-q4"
 *
 * This slug appears in URLs (`/agents/cmo-greg/tasks`) and is what
 * resolveAgentBySlug looks up. It is computed — never stored — so a
 * future rename of an agent's name (currently not allowed) would just
 * flow through here. Because names are immutable post-creation, the
 * slug is effectively immutable too.
 */
export function agentUrlSlug(
  template_key: AgentTemplate["key"],
  name: string,
): string {
  const role = template_key.replace(/_/g, "-");
  return `${role}-${slugifyName(name)}`;
}

/**
 * Lowercase, hyphen-only, no leading/trailing dashes. Trims to a sane
 * length so a misbehaving name input can't blow up the URL.
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
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
 * `names` is an optional partial map of template_key → user-chosen personal
 * name (e.g. { cmo: "Greg", google_ads: "Ana" }). Names are immutable post-
 * creation — when the meta sidecar already has a `name`, we keep it and
 * IGNORE this argument for that agent. Templates with no entry here fall
 * back to the template's `default_name`.
 *
 * The result includes `failed`: when a subprocess fails for one agent, the
 * loop logs + continues (partial provisioning is recoverable) and the
 * caller can decide whether `failed.length > 0` is fatal for their flow.
 */
export async function ensureProjectAgents(
  project_slug: string,
  scope?: AgentTemplateKey[],
  names?: Partial<Record<AgentTemplateKey, string>>,
): Promise<EnsureAgentsResult> {
  const created: string[] = [];
  const existed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  const templates = scope
    ? TEMPLATES.filter((t) => scope.includes(t.key))
    : TEMPLATES;

  // Publish per-template progress so the onboarding setup screen can
  // render a live "Setting up CMO… / Setting up Google Ads agent…"
  // checklist instead of a single opaque spinner. The "gateway" row
  // covers the snapshot-warm-up that happens after the openclaw rows
  // are written.
  const progressSteps: ProgressStep[] = [
    ...templates.map<ProgressStep>((t) => ({
      key: t.key,
      label: `Setting up ${t.display_name}${t.key === "cmo" ? "" : " specialist"}`,
      status: "pending",
    })),
    {
      key: "gateway",
      label: "Connecting agents to gateway",
      status: "pending",
    },
  ];
  initProgress(project_slug, progressSteps);

  for (const template of templates) {
    updateStep(project_slug, template.key, { status: "in_progress" });
    // Resolve the personal name FIRST. The agent_id encodes it, so this
    // value drives both the OpenClaw backend name and the URL slug.
    const personalName = names?.[template.key] ?? template.default_name;
    const agentId = agentNameFor(project_slug, template.key, personalName);
    const workspaceAbs = workspaceDirFor(agentId);
    const already = await agentExists(agentId);
    if (already) {
      // Idempotently refresh the IDENTITY.md so prompt edits propagate to
      // existing agents without forcing the user to delete + recreate.
      await writeIdentityFile(workspaceAbs, template, project_slug, agentId);
      // Read any existing meta so we PRESERVE the previously-chosen name
      // (immutable per the agent model). Only when no sidecar exists yet
      // do we fall back to the onboarding `names` map / template default.
      const existing = readAgentMeta(agentId);
      const finalName = existing?.name ?? personalName;
      await writeAgentMeta({
        agent_id: agentId,
        project_slug,
        name: finalName,
        template_key: template.key,
        created_at: existing?.created_at ?? new Date().toISOString(),
      });
      existed.push(agentId);
      updateStep(project_slug, template.key, { status: "done" });
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
        agentId,
        "--non-interactive",
        "--workspace",
        workspaceAbs,
      ]);
      await writeIdentityFile(workspaceAbs, template, project_slug, agentId);
      await writeAgentMeta({
        agent_id: agentId,
        project_slug,
        name: personalName,
        template_key: template.key,
        created_at: new Date().toISOString(),
      });
      created.push(agentId);
      updateStep(project_slug, template.key, { status: "done" });
    } catch (err) {
      // Surface but don't crash the loop; partial provisioning recoverable on retry.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to create agent ${agentId}:`, err);
      failed.push({ name: agentId, error: message });
      updateStep(project_slug, template.key, {
        status: "failed",
        error: message,
      });
    }
  }

  // After provisioning, the openclaw config file has the new agent rows
  // but the gateway daemon's pinned runtime snapshot lags by a beat —
  // sending chat.send during that window hits an INVALID_REQUEST
  // "Agent '<id>' no longer exists in configuration". Wait until the
  // gateway's agents.list reports every newly-created id so the kickoff
  // path immediately after this (createProjectForOnboardingAction's
  // startTaskIfProposed) finds a warm gateway. Best-effort: a timeout
  // here doesn't block provisioning — runTaskKickoffServerSide also has
  // retry-on-this-error as a second line of defense.
  if (created.length > 0) {
    updateStep(project_slug, "gateway", { status: "in_progress" });
    await waitForGatewayToSeeAgents(created);
    updateStep(project_slug, "gateway", { status: "done" });
  } else {
    updateStep(project_slug, "gateway", { status: "done" });
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

/**
 * Poll the gateway's `agents.list` until every newly-provisioned id shows
 * up (or the timeout expires). Closes the post-`openclaw agents add` race
 * where the runtime config snapshot hasn't caught up to the on-disk
 * config file yet, so chat.send hits "Agent '<id>' no longer exists in
 * configuration".
 */
async function waitForGatewayToSeeAgents(
  expected: string[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const want = new Set(expected);
  while (Date.now() < deadline) {
    try {
      const list = await listAllAgents();
      const seen = new Set(list.agents.map((a) => a.id));
      if ([...want].every((id) => seen.has(id))) return;
    } catch (err) {
      // Transient — gateway may be momentarily unreachable during config
      // rewrites. Fall through to the sleep + retry.
      console.warn(
        `[provision] gateway agents.list probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.warn(
    `[provision] gateway didn't surface all new agents within ${timeoutMs}ms; kickoffs will rely on the retry-on-stale-snapshot path`,
  );
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

    // Project context: PROJECT.md is the single source of truth for "what
    // is this company / project". Written by the CMO during the first
    // onboarding task via `set_project_brief`. We inline it into IDENTITY.md
    // so every agent in the project (CMO + specialists) shares the same
    // context, and write a sidecar PROJECT.md copy so humans inspecting
    // the workspace see what the agent has. The canonical file lives at
    // ~/.notfair-cmo/projects/<slug>/PROJECT.md.
    let projectContextSection = "";
    if (project_slug) {
      const brief = await readProjectBrief(project_slug);
      if (brief !== null) {
        await writeFile(join(workspaceAbs, "PROJECT.md"), brief, "utf8");
        projectContextSection = `\n## Project context\n\nShared across every agent in this project — derived during onboarding\nand kept in sync via the \`set_project_brief\` MCP tool. Treat this as\nthe authoritative description of who the user is and what they sell.\n\n${brief.trim()}\n`;
      }
    }

    // IDENTITY.md = role-specific bits on top, shared skill verbatim
    // below a separator. The separator makes it obvious which half is
    // per-agent and which is shared when a human reads the file.
    const body = `# ${template.display_name}

${template.description}
${identityBlock}${projectContextSection}
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

/**
 * Re-write IDENTITY.md (and the PROJECT.md sidecar) for every agent in a
 * project, picking up the current canonical PROJECT.md. Called by the
 * `set_project_brief` MCP handler after writing the canonical file so
 * specialists get the updated project context without waiting for the
 * next ensureProjectAgents pass.
 *
 * Best-effort per agent: a write failure on one agent is logged but does
 * not abort the others — the new brief is at least canonical on disk, and
 * the next ensureProjectAgents will catch up.
 */
export async function syncProjectBriefToAgents(
  project_slug: string,
): Promise<{ synced: string[]; failed: Array<{ name: string; error: string }> }> {
  // Lazy import to avoid a static cycle: agent-meta -> agent-templates.
  const { listProjectAgents } = await import("./agent-meta");
  const synced: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  const entries = await listProjectAgents(project_slug);
  for (const entry of entries) {
    if (!entry.template_key) {
      // Custom / cloned agent — we don't know its template, but it still
      // has an IDENTITY.md we shouldn't overwrite blindly. Just refresh
      // the sidecar PROJECT.md so a human inspecting sees the new brief.
      try {
        const workspaceAbs = workspaceDirFor(entry.agent_id);
        const { readProjectBrief } = await import("./onboarding/project-brief");
        const brief = await readProjectBrief(project_slug);
        if (brief !== null) {
          await mkdir(workspaceAbs, { recursive: true });
          await writeFile(join(workspaceAbs, "PROJECT.md"), brief, "utf8");
          synced.push(entry.agent_id);
        }
      } catch (err) {
        failed.push({
          name: entry.agent_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    const template = TEMPLATES.find((t) => t.key === entry.template_key);
    if (!template) {
      failed.push({
        name: entry.agent_id,
        error: `Unknown template '${entry.template_key}'`,
      });
      continue;
    }
    try {
      const workspaceAbs = workspaceDirFor(entry.agent_id);
      await writeIdentityFile(workspaceAbs, template, project_slug, entry.agent_id);
      synced.push(entry.agent_id);
    } catch (err) {
      failed.push({
        name: entry.agent_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { synced, failed };
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
