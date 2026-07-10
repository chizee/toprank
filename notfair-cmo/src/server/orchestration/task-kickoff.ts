import { randomUUID } from "node:crypto";

import { getProject } from "@/server/db/projects";
import { listProjectMcpTokens } from "@/server/mcp/tokens";
import type { Task } from "@/types";

/**
 * Generate a UUID for a per-task chat thread. Stable per-call; callers
 * persist it via setTaskThreadIfMissing once they decide to materialize
 * the thread (typically on the first /tasks/[id] page visit, or when
 * approval-wakeup needs to push a system message into a task that's
 * never been opened in the UI).
 */
export function generateTaskThreadId(): string {
  return randomUUID();
}

/**
 * Deterministic snapshot of what's ACTUALLY connected for a project,
 * read from the platform DB at kickoff time. Injected into the kickoff
 * message so the agent never has to derive it — a real onboarding run
 * had the CMO write "no ad account attached" into PROJECT.md even
 * though get_project returned the picked account id.
 */
export interface ProjectPlatformFacts {
  website_url: string | null;
  codebase_path: string | null;
  /** Connected platforms, with the selected account/property when picked. */
  connected: Array<{ label: string; detail: string | null }>;
  /** Recommended platforms with no token — the agent must not assume them. */
  notConnected: string[];
}

const RECOMMENDED_PLATFORMS: Array<{
  key: string;
  label: string;
  detail?: (p: {
    google_ads_account_id: string | null;
    meta_ads_account_id: string | null;
    gsc_property_id: string | null;
  }) => string | null;
}> = [
  {
    key: "notfair-googleads",
    label: "Google Ads",
    detail: (p) =>
      p.google_ads_account_id
        ? `account ${p.google_ads_account_id}`
        : "no account picked yet",
  },
  {
    key: "notfair-metaads",
    label: "Meta Ads",
    detail: (p) =>
      p.meta_ads_account_id
        ? `ad account ${p.meta_ads_account_id}`
        : "no ad account picked yet",
  },
  {
    key: "notfair-googlesearchconsole",
    label: "Google Search Console",
    detail: (p) =>
      p.gsc_property_id ? `property ${p.gsc_property_id}` : "no property picked yet",
  },
  { key: "notfair-googleanalytics", label: "Google Analytics" },
  { key: "notfair-xads", label: "X Ads" },
];

/** Never throws — a facts block is an enhancement, not a gate. */
export function getProjectPlatformFacts(
  project_slug: string,
): ProjectPlatformFacts | null {
  try {
    const project = getProject(project_slug);
    if (!project) return null;
    const tokens = new Set(
      listProjectMcpTokens(project_slug).map((t) => t.server_name),
    );

    const connected: Array<{ label: string; detail: string | null }> = [];
    const notConnected: string[] = [];
    for (const platform of RECOMMENDED_PLATFORMS) {
      if (tokens.has(platform.key)) {
        connected.push({
          label: platform.label,
          detail: platform.detail?.(project) ?? null,
        });
        tokens.delete(platform.key);
      } else {
        notConnected.push(platform.label);
      }
    }
    // Extras connected via "More tools" (stripe, posthog, custom URLs…).
    for (const key of tokens) {
      connected.push({ label: key, detail: null });
    }

    return {
      website_url: project.website_url,
      codebase_path: project.codebase_path,
      connected,
      notConnected,
    };
  } catch {
    return null;
  }
}

/** Pure formatter — separated so tests don't need a DB. */
export function formatPlatformFacts(facts: ProjectPlatformFacts): string[] {
  const lines: string[] = [
    "Platform connections (ground truth from the platform database — trust",
    "this over inference). Point-in-time for THIS task only: more platforms",
    "may connect later, so never copy this list into PROJECT.md or other",
    "durable docs:",
  ];
  for (const c of facts.connected) {
    lines.push(`- ${c.label}: connected${c.detail ? ` — ${c.detail}` : ""}`);
  }
  for (const label of facts.notConnected) {
    lines.push(`- ${label}: NOT connected`);
  }
  if (facts.website_url) lines.push(`- Website: ${facts.website_url}`);
  if (facts.codebase_path) lines.push(`- Local codebase: ${facts.codebase_path}`);
  return lines;
}

/**
 * Build the hidden kickoff message the assignee receives on first open of
 * a task's per-task chat thread. Carries the brief + operating
 * instructions — the agent has everything it needs to acknowledge and
 * start working without the user typing anything.
 *
 * `facts` (from getProjectPlatformFacts, fetched by the caller at kickoff
 * time) grounds the turn in what's actually connected. Passed in rather
 * than fetched here so the formatter stays pure and testable.
 *
 * Kept server-side (in orchestration/) because the format mirrors what
 * the agent's system prompt expects; changing one without the other
 * desyncs the contract.
 */
export function buildTaskKickoffMessage(
  task: Task,
  facts?: ProjectPlatformFacts | null,
): string {
  const lines: string[] = [
    "(task assignment)",
    "",
    `project_slug: ${task.project_slug}`,
    `agent_id:     ${task.agent_id}`,
    `task_id:      ${task.id}`,
    `Title:        ${task.title ?? "(untitled)"}`,
    "",
    "Brief:",
    task.brief,
    "",
  ];
  if (facts) {
    lines.push(...formatPlatformFacts(facts), "");
  }
  if (task.success_criteria) {
    lines.push("Success criteria:", task.success_criteria, "");
  }
  lines.push(
    "Acknowledge this task in 1-2 sentences (what you'll do + roughly how",
    "long), then start working. Use your domain tools to actually do the",
    "thing — don't just describe what you'd do. Close the task out when",
    "you're done.",
  );
  return lines.join("\n");
}
