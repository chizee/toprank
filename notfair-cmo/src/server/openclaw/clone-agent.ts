import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugify } from "@/lib/slug";
import { workspaceDirFor, writeAgentMeta } from "@/server/agent-meta";

const NOTFAIR_DATA_DIR =
  process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
import { openclaw } from "@/server/openclaw/cli";
import {
  createAgentViaRpc,
  getAgentFile,
  listAgentFiles,
} from "@/server/openclaw/gateway-rpc";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
const NAME_SEPARATOR = "/";

export type CloneAgentInput = {
  source_agent_id: string;
  project_slug: string;
  /** URL-safe slug for the new agent (post-project prefix). Required. */
  new_slug: string;
  /** Display name shown in sidebar etc. Defaults to source agent id if unset. */
  display_name?: string;
  /**
   * When true, treat `new_slug` as already-canonical: skip the user-input
   * reserved-slug check (so internal callers can reuse template slugs like
   * `cmo` during a relocate without slugify rejecting them).
   */
  slug_is_canonical?: boolean;
};

export type CloneSourceCron = {
  id: string;
  /** The cron's original name, kept so the UI can show the user what they're disabling. */
  name: string;
  disabled: boolean;
};

export type CloneAgentResult = {
  new_agent_id: string;
  new_slug: string;
  files_copied: number;
  sessions_copied: number;
  source_crons: CloneSourceCron[];
  new_cron_ids: string[];
};

/**
 * Clone an existing OpenClaw agent into the active project.
 *
 * Steps (in order; each is idempotent enough to retry after a partial failure):
 *   1. Validate inputs + compute target ids.
 *   2. Create the destination agent via `agents.create` RPC.
 *   3. Copy workspace files (read via agents.files.get, write via agents.files.set).
 *   4. Filesystem-copy ~/.openclaw/agents/<src>/sessions → ~/.openclaw/agents/<dst>/sessions
 *      and rewrite sessions.json keys to point at the new agent name.
 *   5. List source crons, recreate each targeting the new agent with our
 *      `<project> / <slug> / <cron>` naming convention.
 *   6. Write our notfair-meta sidecar so the sidebar finds it.
 */
export async function cloneAgent(input: CloneAgentInput): Promise<CloneAgentResult> {
  let newSlug: string;
  if (input.slug_is_canonical) {
    // Internal caller (e.g. relocateAgent) has a slug that already passed
    // user-facing validation at creation time. Re-running slugify would
    // reject reserved slugs like `cmo` that are valid template slugs.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.new_slug)) {
      throw new Error(`Invalid canonical slug: ${input.new_slug}`);
    }
    newSlug = input.new_slug;
  } else {
    const slugResult = slugify(input.new_slug);
    if (!slugResult.ok) {
      throw new Error(`Invalid agent slug: ${slugResult.reason}`);
    }
    newSlug = slugResult.slug;
  }
  const newAgentId = `${input.project_slug}-${newSlug}`;
  if (agentExistsInProject(input.project_slug, newSlug)) {
    throw new Error(
      `An agent named "${newSlug}" already exists in this project. Pick a different name.`,
    );
  }
  const dstWorkspace = workspaceDirFor(newAgentId);
  const displayName = (input.display_name ?? input.source_agent_id).trim() || input.source_agent_id;

  // 2) Create the destination agent.
  await createAgentViaRpc({ name: newAgentId, workspace: dstWorkspace });

  // 3) Copy workspace files.
  let filesCopied = 0;
  try {
    const list = await listAgentFiles(input.source_agent_id);
    for (const f of list.files) {
      if (f.missing) continue;
      try {
        const got = await getAgentFile(input.source_agent_id, f.name);
        // Use the gateway's setter so OpenClaw's safety/symlink checks run.
        await callAgentsFilesSet(newAgentId, f.name, got.file.content);
        filesCopied++;
      } catch (err) {
        console.error(`clone: skipping file ${f.name}:`, err);
      }
    }
  } catch (err) {
    console.error("clone: could not list source workspace files:", err);
  }

  // 4) Copy sessions (filesystem) + rewrite sessions.json keys.
  const srcSessionsDir = join(OPENCLAW_HOME, "agents", input.source_agent_id, "sessions");
  const dstSessionsDir = join(OPENCLAW_HOME, "agents", newAgentId, "sessions");
  let sessionsCopied = 0;
  if (existsSync(srcSessionsDir)) {
    await mkdir(dstSessionsDir, { recursive: true });
    // Copy everything (jsonl, .trajectory*, sessions.json, .bak files). `force:true`
    // overwrites anything OpenClaw auto-created at agents.create time.
    await cp(srcSessionsDir, dstSessionsDir, { recursive: true, force: true });

    // Rewrite sessions.json so key prefix matches the new agent. Without this,
    // OpenClaw won't recognize the imported entries as belonging to the dest.
    const dstSessionsJson = join(dstSessionsDir, "sessions.json");
    if (existsSync(dstSessionsJson)) {
      try {
        const raw = await readFile(dstSessionsJson, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const oldPrefix = `agent:${input.source_agent_id}:`;
        const newPrefix = `agent:${newAgentId}:`;
        const rewritten: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const newKey = k.startsWith(oldPrefix) ? newPrefix + k.slice(oldPrefix.length) : k;
          rewritten[newKey] = v;
          sessionsCopied++;
        }
        await writeFile(dstSessionsJson, JSON.stringify(rewritten, null, 2), "utf8");
      } catch (err) {
        console.error("clone: could not rewrite sessions.json:", err);
      }
    }
  }

  // 5) Crons.
  const sourceCrons: CloneSourceCron[] = [];
  const newCronIds: string[] = [];
  try {
    const allCrons = await loadAllCrons();
    const mine = allCrons.filter((c) => c.agentId === input.source_agent_id);
    for (const c of mine) {
      sourceCrons.push({ id: c.id, name: c.name, disabled: c.enabled === false || !!c.disabled });
      try {
        const newId = await createClonedCron(c, input.project_slug, newSlug, newAgentId);
        newCronIds.push(newId);
      } catch (err) {
        console.error(`clone: could not recreate cron '${c.name}':`, err);
      }
    }
  } catch (err) {
    console.error("clone: could not list crons:", err);
  }

  // 6) Meta sidecar so the sidebar shows the new agent. Cloned agents
  //    aren't backed by a template — they keep the user-chosen `slug`
  //    on the sidecar (the rest of the system computes template agents'
  //    slugs from template_key + name instead).
  await writeAgentMeta({
    agent_id: newAgentId,
    project_slug: input.project_slug,
    slug: newSlug,
    name: displayName,
    source_agent_id: input.source_agent_id,
    created_at: new Date().toISOString(),
  });

  return {
    new_agent_id: newAgentId,
    new_slug: newSlug,
    files_copied: filesCopied,
    sessions_copied: sessionsCopied,
    source_crons: sourceCrons,
    new_cron_ids: newCronIds,
  };
}

// --- helpers ---

/**
 * True if a project already has an agent at this slug. Considers both our
 * notfair meta sidecar and OpenClaw's agent dir, but only counts directories
 * that contain something — OpenClaw's `agents.delete` leaves an empty parent
 * dir behind after moving the contents to trash, and we don't want that
 * remnant to block reusing the slug.
 */
export function agentExistsInProject(project_slug: string, slug: string): boolean {
  const agentId = `${project_slug}-${slug}`;
  return (
    hasNonEmptyDir(join(NOTFAIR_DATA_DIR, "agents", agentId)) ||
    hasNonEmptyDir(join(OPENCLAW_HOME, "agents", agentId))
  );
}

function hasNonEmptyDir(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(path).length > 0;
  } catch {
    return true; // be conservative if we can't read it
  }
}

async function callAgentsFilesSet(agentId: string, name: string, content: string): Promise<void> {
  // setAgentFile in gateway-rpc.ts already wraps this; import lazily to keep
  // the top of this file readable.
  const { setAgentFile } = await import("./gateway-rpc");
  await setAgentFile(agentId, name, content);
}

type RawCron = {
  id: string;
  agentId?: string;
  name: string;
  enabled?: boolean;
  disabled?: boolean;
  description?: string;
  schedule?:
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "every"; everyMs: number; anchorMs?: number }
    | { kind: string; [k: string]: unknown };
  payload?: { kind?: string; message?: string; timeoutSeconds?: number };
};

async function loadAllCrons(): Promise<RawCron[]> {
  // Read jobs.json directly — same data the CLI prints, but avoids spawning
  // a subprocess (which can be 5–15s on cold paths).
  const jobsPath = join(OPENCLAW_HOME, "cron", "jobs.json");
  if (!existsSync(jobsPath)) return [];
  try {
    const raw = readFileSync(jobsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as RawCron[];
    if (parsed && typeof parsed === "object") {
      const cands = parsed as { jobs?: unknown; crons?: unknown };
      if (Array.isArray(cands.jobs)) return cands.jobs as RawCron[];
      if (Array.isArray(cands.crons)) return cands.crons as RawCron[];
    }
  } catch {
    // Fall through to empty list.
  }
  return [];
}

async function createClonedCron(
  source: RawCron,
  projectSlug: string,
  newAgentSlug: string,
  newAgentId: string,
): Promise<string> {
  // Convention: `<project>/<agent-slug>/<cron-slug>` (no surrounding spaces).
  // When cloning, the source's name may already follow `<proj>/<agent>/<cron>`
  // (e.g. a clone of a clone). Only take the trailing segment so we don't
  // end up with redundant project/agent prefixes baked into the cron slug.
  const lastSegment = source.name.split(/\s*\/\s*/).pop()?.trim() ?? source.name;
  const slugAttempt = slugify(lastSegment);
  const cronSlug = slugAttempt.ok && slugAttempt.slug ? slugAttempt.slug : "cloned-job";
  const fullName = `${projectSlug}${NAME_SEPARATOR}${newAgentSlug}${NAME_SEPARATOR}${cronSlug}`;

  const args = [
    "cron",
    "add",
    "--name",
    fullName,
    "--agent",
    newAgentId,
    "--no-deliver",
  ];
  if (source.description) {
    args.push("--description", source.description);
  }
  const message = source.payload?.message ?? "";
  if (message) {
    args.push("--message", message);
  }
  const schedule = source.schedule;
  if (schedule?.kind === "cron" && typeof (schedule as { expr?: string }).expr === "string") {
    args.push("--cron", (schedule as { expr: string }).expr);
    const tz = (schedule as { tz?: string }).tz;
    if (tz) args.push("--tz", tz);
  } else if (schedule?.kind === "every" && typeof (schedule as { everyMs?: number }).everyMs === "number") {
    args.push("--every", msToDuration((schedule as { everyMs: number }).everyMs));
  } else {
    // Unknown schedule shape — fall back to disabled hourly so we don't lose
    // the job. User will see it in the crons tab and can fix.
    args.push("--every", "1h");
  }

  const result = (await openclaw(args)) as { id?: string };
  if (!result?.id) throw new Error(`openclaw cron add returned no id for '${fullName}'`);
  return String(result.id);
}

function msToDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
