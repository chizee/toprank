import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cache } from "react";
import { openclaw } from "./cli";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");

/**
 * Module-level in-memory cache for the `openclaw cron list` subprocess.
 * Single-user local app, so a tiny TTL across requests is safe and avoids
 * 1-2s subprocess spawns blocking every page render. Per-request dedup is
 * additionally handled by React's `cache()` wrapper below.
 */
// Cron list rarely changes second-to-second; cache aggressively so the upstream
// `openclaw cron list` subprocess (which can take 5-15s on some machines) does
// not block every page render.
const CACHE_TTL_MS = 30_000;
let cachedCronsAt = 0;
let cachedCronsPromise: Promise<unknown> | null = null;

async function rawListAllCrons(): Promise<unknown> {
  const now = Date.now();
  if (cachedCronsPromise && now - cachedCronsAt < CACHE_TTL_MS) {
    return cachedCronsPromise;
  }
  cachedCronsAt = now;
  // `--all` because the CLI defaults to enabled-only and we want disabled
  // crons in the calendar too (so the Disabled filter has something to show).
  cachedCronsPromise = openclaw(["cron", "list", "--all"]).catch((err) => {
    // Invalidate on failure so the next caller retries instead of getting a cached reject.
    cachedCronsAt = 0;
    cachedCronsPromise = null;
    throw err;
  });
  return cachedCronsPromise;
}

export function invalidateCronCache(): void {
  cachedCronsAt = 0;
  cachedCronsPromise = null;
}

type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: string; [k: string]: unknown };

type CronState = {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  lastRunStatus?: string;
  lastError?: string;
  lastErrorReason?: string;
  runs?: number;
};

export type OpenClawCron = {
  id: string;
  name: string;
  description?: string;
  agentId?: string;
  schedule?: CronSchedule;
  state?: CronState;
  disabled?: boolean;
  enabled?: boolean;
  payload?: { kind?: string; message?: string; timeoutSeconds?: number };
  // Catch any other fields without losing them.
  [k: string]: unknown;
};

export type DisplayCron = {
  id: string;
  name: string;
  short_name: string;
  agent_id: string;
  /** Short, project-stripped agent slug (e.g. "google-ads") for color lookup. */
  agent_slug: string;
  schedule_raw: CronSchedule | undefined;
  schedule_text: string;
  next_run_text: string;
  last_run_text: string;
  status_text: string;
  disabled: boolean;
  /** The prompt/message the cron sends to the agent on each tick. */
  message?: string;
  description?: string;
  /** Last execution time (ms epoch); used to align "ran" vs "scheduled" per occurrence. */
  last_run_at_ms?: number;
  /** Raw status string from OpenClaw (e.g. "ok", "error", "skipped"). */
  last_status?: string;
  last_error?: string;
  next_run_at_ms?: number;
};

export type CronGroup = {
  agent: string;
  crons: DisplayCron[];
};

export type ProjectCronView = {
  project_slug: string;
  groups: CronGroup[];
};

const NAME_SEPARATOR = "/";

/**
 * Fetch all crons from OpenClaw and group by project prefix + agent.
 * Project prefix convention: cron name is `<project-slug> / <agent-slug> / <cron-slug>`.
 * We also match crons whose `agentId` starts with `<project-slug>-` for crons
 * created outside this naming convention (e.g., directly via openclaw cli).
 */
export const listCronsForProject = cache(async (project_slug: string): Promise<ProjectCronView> => {
  const raw = await rawListAllCrons();
  const allCrons = normalize(raw);

  const matching = allCrons.filter((c) => {
    const name = (c.name ?? "").trim();
    if (
      name.startsWith(`${project_slug} ${NAME_SEPARATOR}`) ||
      name.startsWith(`${project_slug}${NAME_SEPARATOR}`)
    ) {
      return true;
    }
    if (c.agentId && c.agentId.startsWith(`${project_slug}-`)) {
      return true;
    }
    return false;
  });

  const byAgent = new Map<string, DisplayCron[]>();
  for (const cron of matching) {
    const agentId = cron.agentId ?? deriveAgentFromName(cron.name, project_slug) ?? "unknown";
    const shortAgent = shortenAgentId(agentId, project_slug);
    const display = toDisplay(cron, shortAgent, project_slug);
    const list = byAgent.get(shortAgent) ?? [];
    list.push(display);
    byAgent.set(shortAgent, list);
  }

  const groups: CronGroup[] = Array.from(byAgent.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, crons]) => ({ agent, crons }));

  return { project_slug, groups };
});

function toDisplay(cron: OpenClawCron, shortAgent: string, _project_slug: string): DisplayCron {
  const agent_id = cron.agentId ?? "unknown";
  const disabled = !!cron.disabled || cron.enabled === false;
  const rawStatus = cron.state?.lastStatus ?? cron.state?.lastRunStatus;
  const status_text = disabled ? "disabled" : rawStatus ?? "idle";
  return {
    id: cron.id,
    name: cron.name,
    short_name: deriveCronShortName(cron.name),
    agent_id,
    agent_slug: shortAgent,
    schedule_raw: cron.schedule,
    schedule_text: formatSchedule(cron.schedule),
    next_run_text: formatRelativeMs(cron.state?.nextRunAtMs),
    last_run_text: formatRelativeMs(cron.state?.lastRunAtMs),
    status_text,
    disabled,
    message: cron.payload?.message,
    description: cron.description,
    last_run_at_ms: cron.state?.lastRunAtMs,
    last_status: rawStatus,
    last_error: cron.state?.lastError ?? cron.state?.lastErrorReason,
    next_run_at_ms: cron.state?.nextRunAtMs,
  };
}

function formatSchedule(schedule: CronSchedule | undefined): string {
  if (!schedule) return "—";
  if (schedule.kind === "cron" && "expr" in schedule) {
    return schedule.tz
      ? `${schedule.expr}  ·  ${schedule.tz}`
      : (schedule.expr as string);
  }
  if (schedule.kind === "every" && "everyMs" in schedule) {
    return `every ${formatDurationMs(schedule.everyMs as number)}`;
  }
  return JSON.stringify(schedule);
}

function formatDurationMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatRelativeMs(ms: number | undefined): string {
  if (!ms) return "—";
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const seconds = Math.round(abs / 1000);
  if (seconds < 60) {
    return delta > 0 ? `in ${seconds}s` : `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return delta > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return delta > 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return delta > 0 ? `in ${days}d` : `${days}d ago`;
}

function normalize(raw: unknown): OpenClawCron[] {
  if (Array.isArray(raw)) return raw as OpenClawCron[];
  if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>;
    if (Array.isArray(candidate.jobs)) return candidate.jobs as OpenClawCron[];
    if (Array.isArray(candidate.crons)) return candidate.crons as OpenClawCron[];
  }
  return [];
}

function deriveAgentFromName(name: string | undefined, project_slug: string): string | null {
  if (!name) return null;
  const parts = name.split(NAME_SEPARATOR).map((s) => s.trim());
  if (parts.length >= 2 && parts[0] === project_slug) return parts[1];
  return null;
}

function deriveCronShortName(name: string): string {
  const parts = name.split(NAME_SEPARATOR).map((s) => s.trim());
  return parts[parts.length - 1] ?? name;
}

function shortenAgentId(agentId: string, project_slug: string): string {
  const prefix = `${project_slug}-`;
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : agentId;
}

export async function disableCron(id: string): Promise<void> {
  await openclaw(["cron", "disable", id], { json: false });
  invalidateCronCache();
}

export async function enableCron(id: string): Promise<void> {
  await openclaw(["cron", "enable", id], { json: false });
  invalidateCronCache();
}

export async function removeCron(id: string): Promise<void> {
  await openclaw(["cron", "rm", id], { json: false });
  invalidateCronCache();
}

export type CreateCronInput = {
  project_slug: string;
  agent_slug: string;
  agent_full_id: string;
  cron_name: string;
  schedule:
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "every"; duration: string };
  message: string;
  description?: string;
};

export type CreateCronResult = {
  id: string;
  name: string;
};

/**
 * Create a cron in OpenClaw using our naming convention.
 * Called by the `schedule_recurring_work` MCP tool from specialist agents.
 */
// --- Per-run history ---

export type CronRun = {
  /** When the run was scheduled to fire (matches calendar occurrence.at within ~seconds). */
  run_at_ms: number;
  /** When the run finished (ts in the JSONL). */
  finished_at_ms: number;
  /** Raw OpenClaw status: "ok" | "error" | "skipped" | etc. */
  status: string;
  /** Agent's final reply / report. Empty when missing (e.g. crashed runs). */
  summary: string;
  /** Failure detail string, when status="error". */
  error?: string;
  duration_ms?: number;
  session_id?: string;
  model?: string;
  provider?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

/**
 * Read the per-job cron run log. Returns the most recent runs (newest first).
 * The file is JSONL with one entry per finished run, persisted by OpenClaw's
 * cron service under `~/.openclaw/cron/runs/<jobId>.jsonl`.
 */
export function loadCronRuns(cron_id: string, limit = 100): CronRun[] {
  const path = join(OPENCLAW_HOME, "cron", "runs", `${cron_id}.jsonl`);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  // Iterate newest-last → flip + cap.
  const out: CronRun[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.action !== "finished") continue;
    const run_at_ms = typeof entry.runAtMs === "number" ? entry.runAtMs : 0;
    if (!run_at_ms) continue;
    out.push({
      run_at_ms,
      finished_at_ms: typeof entry.ts === "number" ? entry.ts : run_at_ms,
      status: typeof entry.status === "string" ? entry.status : "unknown",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      error: typeof entry.error === "string" ? entry.error : undefined,
      duration_ms: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
      session_id: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
      model: typeof entry.model === "string" ? entry.model : undefined,
      provider: typeof entry.provider === "string" ? entry.provider : undefined,
      usage:
        entry.usage && typeof entry.usage === "object"
          ? (entry.usage as CronRun["usage"])
          : undefined,
    });
  }
  return out;
}

export async function createCron(input: CreateCronInput): Promise<CreateCronResult> {
  const fullName = `${input.project_slug}${NAME_SEPARATOR}${input.agent_slug}${NAME_SEPARATOR}${input.cron_name}`;
  const args = [
    "cron",
    "add",
    "--name",
    fullName,
    "--agent",
    input.agent_full_id,
    "--message",
    input.message,
    "--no-deliver",
  ];
  if (input.description) {
    args.push("--description", input.description);
  }
  if (input.schedule.kind === "cron") {
    args.push("--cron", input.schedule.expr);
    if (input.schedule.tz) args.push("--tz", input.schedule.tz);
  } else {
    args.push("--every", input.schedule.duration);
  }
  const result = (await openclaw(args)) as { id?: string; name?: string };
  invalidateCronCache();
  return {
    id: String(result?.id ?? ""),
    name: String(result?.name ?? fullName),
  };
}
