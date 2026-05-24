"use server";

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { getActiveProject } from "@/server/active-project";
import { disableCron, listCronsForProject, removeCron } from "@/server/openclaw/crons";
import {
  createAgentViaRpc,
  deleteAgent,
  listAllAgents,
} from "@/server/openclaw/gateway-rpc";
import {
  agentExistsInProject,
  cloneAgent,
  type CloneAgentResult,
} from "@/server/openclaw/clone-agent";
import {
  readAgentMeta,
  writeAgentMeta,
  workspaceDirFor,
  listProjectAgents,
  type AgentMeta,
  type ProjectAgentEntry,
} from "@/server/agent-meta";
import { listSessionsForAgent } from "@/server/openclaw/sessions";
import { slugify } from "@/lib/slug";
import type { AgentTemplate } from "@/server/agent-templates";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type AgentChoice = {
  agent_id: string;
  display_name: string;
  in_current_project: boolean;
};

export async function listOpenClawAgentsAction(): Promise<ActionResult<AgentChoice[]>> {
  try {
    const project = await getActiveProject();
    const projectAgentIds = new Set<string>(
      project
        ? (await listProjectAgents(project.slug)).map((a) => a.agent_id)
        : [],
    );
    const list = await listAllAgents();
    const out: AgentChoice[] = list.agents.map((a) => ({
      agent_id: a.id,
      display_name: a.identity?.name?.trim() || a.name?.trim() || a.id,
      in_current_project: projectAgentIds.has(a.id),
    }));
    out.sort((a, b) => a.display_name.localeCompare(b.display_name));
    return { ok: true, data: out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listProjectAgentsAction(): Promise<ActionResult<ProjectAgentEntry[]>> {
  const project = await getActiveProject();
  if (!project) return { ok: false, error: "No active project." };
  try {
    return { ok: true, data: await listProjectAgents(project.slug) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type CreateAgentInput = {
  display_name: string;
};

export async function createAgentAction(
  input: CreateAgentInput,
): Promise<ActionResult<{ agent_id: string; slug: string }>> {
  const project = await getActiveProject();
  if (!project) return { ok: false, error: "No active project." };
  const slug = slugify(input.display_name);
  if (!slug.ok) return { ok: false, error: `Invalid name: ${slug.reason}` };

  if (agentExistsInProject(project.slug, slug.slug)) {
    return {
      ok: false,
      error: `An agent named "${slug.slug}" already exists in this project.`,
    };
  }

  const agentId = `${project.slug}-${slug.slug}`;
  const workspace = workspaceDirFor(agentId);
  try {
    await createAgentViaRpc({ name: agentId, workspace });
    await writeAgentMeta({
      agent_id: agentId,
      project_slug: project.slug,
      slug: slug.slug,
      name: input.display_name.trim(),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/", "layout");
  return { ok: true, data: { agent_id: agentId, slug: slug.slug } };
}

export type CloneAgentActionInput = {
  source_agent_id: string;
  new_display_name: string;
  /** Optional override for the URL slug; defaults to slugified display name. */
  new_slug?: string;
};

export async function cloneAgentAction(
  input: CloneAgentActionInput,
): Promise<ActionResult<CloneAgentResult>> {
  const project = await getActiveProject();
  if (!project) return { ok: false, error: "No active project." };

  const slugSource = (input.new_slug ?? input.new_display_name).trim();
  if (!slugSource) {
    return { ok: false, error: "Please provide a name for the cloned agent." };
  }
  try {
    const result = await cloneAgent({
      source_agent_id: input.source_agent_id,
      project_slug: project.slug,
      new_slug: slugSource,
      display_name: input.new_display_name,
    });
    revalidatePath("/", "layout");
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function disableCronsAction(
  cronIds: string[],
): Promise<ActionResult<{ disabled: number; failed: number }>> {
  let disabled = 0;
  let failed = 0;
  for (const id of cronIds) {
    try {
      await disableCron(id);
      disabled++;
    } catch {
      failed++;
    }
  }
  revalidatePath("/", "layout");
  return { ok: true, data: { disabled, failed } };
}

// --- Relocate (used by per-agent rename AND project rename) ---

export type RelocateAgentInput = {
  /** Current full agent_id (e.g. `acme-supa`). */
  old_agent_id: string;
  /** Source project slug — used for cron-cleanup lookup. */
  source_project_slug: string;
  /** Destination project slug — same as source for a rename within a project. */
  new_project_slug: string;
  /** Destination agent slug — same as source when only the project changes. */
  new_slug: string;
  /** Display name to write into the new agent's meta sidecar. */
  new_display_name: string;
  /**
   * Optional template_key to preserve on the new agent's meta sidecar (kept
   * during renames so the sidebar icon stays consistent for template-derived
   * agents).
   */
  preserve_template_key?: AgentTemplate["key"];
  /** Optional source_agent_id to preserve on the new meta (clone provenance). */
  preserve_source_agent_id?: string;
  /** Optional original created_at to keep the agent's age stable. */
  preserve_created_at?: string;
};

export type RelocateAgentResult = {
  new_agent_id: string;
  new_slug: string;
};

/**
 * Move an agent from one (project, slug) to another. Underneath: full clone
 * into the destination identifiers, overwrite meta with the preserved fields,
 * then cascade-delete the source. Shared by per-agent rename (same project,
 * new slug) and project rename (new project, same slug per agent).
 *
 * Throws on clone failure (source stays intact). If clone succeeds but the
 * source delete partially fails, the destination is still live and the caller
 * can surface a warning.
 */
export async function relocateAgent(
  input: RelocateAgentInput,
): Promise<RelocateAgentResult> {
  const cloneResult = await cloneAgent({
    source_agent_id: input.old_agent_id,
    project_slug: input.new_project_slug,
    new_slug: input.new_slug,
    display_name: input.new_display_name,
    // We're handing cloneAgent an already-canonical slug from existing meta,
    // not user input — skip the reserved-slug check so template slugs like
    // `cmo` survive a relocate.
    slug_is_canonical: true,
  });

  // Overwrite meta to drop the clone-provenance fields that cloneAgent set,
  // and preserve the caller-supplied identity (template_key, source, created).
  // Template agents don't persist `slug` (it's computed); clones do.
  const isTemplateAgent = !!input.preserve_template_key;
  await writeAgentMeta({
    agent_id: cloneResult.new_agent_id,
    project_slug: input.new_project_slug,
    ...(isTemplateAgent ? {} : { slug: cloneResult.new_slug }),
    name: input.new_display_name,
    ...(input.preserve_template_key ? { template_key: input.preserve_template_key } : {}),
    ...(input.preserve_source_agent_id
      ? { source_agent_id: input.preserve_source_agent_id }
      : {}),
    created_at: input.preserve_created_at ?? new Date().toISOString(),
  });

  // Delete the source (its crons are looked up under its source project).
  // Best-effort — if it fails the new agent is still usable.
  await cascadeDeleteAgent({
    agent_id: input.old_agent_id,
    projectSlug: input.source_project_slug,
  }).catch(() => {});

  return {
    new_agent_id: cloneResult.new_agent_id,
    new_slug: cloneResult.new_slug,
  };
}

// --- Rename ---

export type RenameAgentInput = {
  /** Current agent_id (e.g. `e2e-test-brand-supa`). */
  agent_id: string;
  /** New display name; slugified to derive the new URL slug. */
  new_display_name: string;
};

export type RenameAgentData = {
  agent_id: string;
  slug: string;
  display_name: string;
  /** True when the slug actually changed (i.e. a full clone+delete ran). */
  full_rename: boolean;
};

/**
 * Per the agent-identity refactor, agents are IMMUTABLE after creation:
 * the name set during onboarding (or clone time) is permanent and the URL
 * slug is computed from it. This action is preserved so internal callers
 * (project-rename cascade via relocateAgent) keep working, but the
 * user-facing rename UI has been removed.
 *
 * For template agents the action refuses — template names are part of the
 * sidebar/role-pill identity the user named at onboarding. For cloned/
 * custom agents the action also refuses; they were already named at clone
 * time.
 */
export async function renameAgentAction(
  _input: RenameAgentInput,
): Promise<ActionResult<RenameAgentData>> {
  return {
    ok: false,
    error: "Agents are immutable once created. To use a different name, clone the agent and delete the original.",
  };
}

// --- Per-agent deletion ---

export type AgentDeletionSummary = {
  agent_id: string;
  display_name: string;
  exists_in_openclaw: boolean;
  threads: Array<{ session_id: string; label: string; last_interaction_at: number }>;
  crons: Array<{ id: string; name: string; disabled: boolean }>;
  source_agent_id?: string;
  template_key?: string;
};

export async function getAgentDeletionSummaryAction(
  agent_id: string,
): Promise<ActionResult<AgentDeletionSummary>> {
  const project = await getActiveProject();
  if (!project) return { ok: false, error: "No active project." };

  const meta: AgentMeta | null = readAgentMeta(agent_id);
  const agentDir = join(OPENCLAW_HOME, "agents", agent_id);
  const existsInOpenclaw = existsSync(agentDir);
  const sessions = existsInOpenclaw ? listSessionsForAgent(agent_id) : [];
  const threads = sessions.map((s) => ({
    session_id: s.sessionId,
    label: s.label,
    last_interaction_at: s.lastInteractionAt,
  }));

  const crons: Array<{ id: string; name: string; disabled: boolean }> = [];
  try {
    const view = await listCronsForProject(project.slug);
    for (const g of view.groups) {
      for (const c of g.crons) {
        if (c.agent_id !== agent_id) continue;
        crons.push({ id: c.id, name: c.short_name || c.name, disabled: c.disabled });
      }
    }
  } catch {
    // Best-effort; cron service unreachable means we just show an empty list.
  }

  return {
    ok: true,
    data: {
      agent_id,
      display_name: meta?.name ?? agent_id,
      exists_in_openclaw: existsInOpenclaw,
      threads,
      crons,
      source_agent_id: meta?.source_agent_id,
      template_key: meta?.template_key,
    },
  };
}

export type DeleteAgentData = {
  agent_id: string;
  crons_removed: number;
  crons_failed: number;
  openclaw_deleted: boolean;
  meta_removed: boolean;
};

/**
 * Cascading agent deletion: removes the agent's crons, calls OpenClaw's
 * `agents.delete` RPC (with deleteFiles:true so workspace + sessions go too),
 * and cleans up the empty parent dirs OpenClaw and our meta sidecar leave
 * behind. Shared by per-agent delete (settings danger zone) and project-wide
 * delete so the cleanup logic stays in one place.
 *
 * Pure helper — does NOT revalidate, redirect, or touch cookies. Callers add
 * their own surrounding concerns (per-agent action revalidates the layout,
 * project delete clears the active-project cookie + db rows).
 *
 * Pass `cronsByAgentId` to skip the cron lookup when the caller already has
 * it (project-wide delete grabs every project cron once up front).
 */
export type CascadeAgentDeleteOutcome = {
  agent_id: string;
  crons_removed: number;
  crons_failed: number;
  openclaw_deleted: boolean;
  meta_removed: boolean;
};

export async function cascadeDeleteAgent(opts: {
  agent_id: string;
  /**
   * Optional: caller-supplied list of cron IDs to remove for this agent.
   * When omitted, we look them up via the project's cron list.
   */
  projectSlug?: string;
  cronIds?: string[];
}): Promise<CascadeAgentDeleteOutcome> {
  const { agent_id } = opts;

  // 1) Remove agent's crons first — once the agent is gone OpenClaw may reject
  //    removeCron for orphans.
  let cronsRemoved = 0;
  let cronsFailed = 0;
  let cronIds = opts.cronIds;
  if (!cronIds && opts.projectSlug) {
    try {
      const view = await listCronsForProject(opts.projectSlug);
      cronIds = view.groups
        .flatMap((g) => g.crons)
        .filter((c) => c.agent_id === agent_id)
        .map((c) => c.id);
    } catch {
      cronIds = [];
    }
  }
  for (const id of cronIds ?? []) {
    try {
      await removeCron(id);
      cronsRemoved++;
    } catch {
      cronsFailed++;
    }
  }

  // 2) Delete the OpenClaw agent.
  let openclawDeleted = false;
  try {
    await deleteAgent(agent_id);
    openclawDeleted = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unknown agent") || msg.includes("not found")) {
      openclawDeleted = true; // already gone — treat as success
    } else {
      // Rethrow so callers can decide whether to abort.
      throw err;
    }
  }

  // 3) Remove our meta sidecar + workspace dir.
  let metaRemoved = false;
  try {
    const wsDir = workspaceDirFor(agent_id);
    if (existsSync(wsDir)) {
      await rm(wsDir, { recursive: true, force: true });
      metaRemoved = true;
    }
  } catch {
    // Non-fatal; agent stays shadow-visible until the sidecar disappears.
  }

  // 4) OpenClaw's deleteFiles:true trashes the dir contents but leaves the
  //    now-empty `~/.openclaw/agents/<id>/` parent behind. Remove it so the
  //    slug becomes free to reuse immediately (otherwise next rename/clone
  //    rejects with "already exists").
  try {
    const openclawAgentDir = join(OPENCLAW_HOME, "agents", agent_id);
    if (existsSync(openclawAgentDir)) {
      await rm(openclawAgentDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort — trashed contents already represent a successful delete.
  }

  return {
    agent_id,
    crons_removed: cronsRemoved,
    crons_failed: cronsFailed,
    openclaw_deleted: openclawDeleted,
    meta_removed: metaRemoved,
  };
}

export async function deleteAgentCascadeAction(
  agent_id: string,
): Promise<ActionResult<DeleteAgentData>> {
  const project = await getActiveProject();
  if (!project) return { ok: false, error: "No active project." };

  let outcome: CascadeAgentDeleteOutcome;
  try {
    outcome = await cascadeDeleteAgent({
      agent_id,
      projectSlug: project.slug,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `OpenClaw refused to delete agent: ${msg}` };
  }

  revalidatePath("/", "layout");
  return { ok: true, data: outcome };
}

/** Used by the clone-result confirmation if the user opts to delete instead. */
export async function removeCronsAction(
  cronIds: string[],
): Promise<ActionResult<{ removed: number; failed: number }>> {
  let removed = 0;
  let failed = 0;
  for (const id of cronIds) {
    try {
      await removeCron(id);
      removed++;
    } catch {
      failed++;
    }
  }
  revalidatePath("/", "layout");
  return { ok: true, data: { removed, failed } };
}
