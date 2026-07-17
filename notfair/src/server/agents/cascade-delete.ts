import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { listProjectAgents } from "@/server/agent-meta";
import { getMcpCatalog } from "@/server/mcp-catalog";
import { listProjectMcpTokens, deleteProjectMcpTokens } from "@/server/mcp/tokens";
import { listAgentSessions } from "@/server/sessions";
import { workspaceDirFor } from "./provisioning";
import { getProject } from "@/server/db/projects";
import { requireAdapter } from "@/server/adapters/registry";
import { getDb } from "@/server/db/db";

export interface ProjectDeletionAgentSummary {
  display_name: string;
  agentId: string;
  exists: boolean;
  threadCount: number;
}

export interface ProjectDeletionMcpSummary {
  catalog_key: string;
  display_name: string;
  stored_key: string;
  configured: boolean;
}

export interface ProjectDeletionSummary {
  project_slug: string;
  agents: ProjectDeletionAgentSummary[];
  mcps: ProjectDeletionMcpSummary[];
  totals: {
    agents: number;
    threads: number;
    mcps: number;
  };
}

/**
 * Inventory everything tied to a project so the confirmation dialog can show
 * the user exactly what will be deleted. Reads-only.
 */
export async function getProjectDeletionSummary(
  project_slug: string,
): Promise<ProjectDeletionSummary> {
  const entries = await listProjectAgents(project_slug);
  const agents: ProjectDeletionAgentSummary[] = entries.map((e) => {
    const dir = workspaceDirFor(e.agent_id);
    const exists = existsSync(dir);
    const threadCount = exists ? listAgentSessions(project_slug, e.agent_id).length : 0;
    return {
      display_name: e.name,
      agentId: e.agent_id,
      exists,
      threadCount,
    };
  });

  // MCP connections live in the mcp_tokens table now. Per-catalog "configured"
  // status is derived from whether a token row exists for the (project, server)
  // pair.
  const tokens = listProjectMcpTokens(project_slug);
  const tokenServers = new Set(tokens.map((t) => t.server_name));
  const mcps: ProjectDeletionMcpSummary[] = getMcpCatalog(project_slug).map(
    (spec) => ({
      catalog_key: spec.key,
      display_name: spec.display_name,
      stored_key: `${project_slug}-${spec.key}`,
      configured: tokenServers.has(spec.key),
    }),
  );

  return {
    project_slug,
    agents,
    mcps,
    totals: {
      agents: agents.filter((a) => a.exists).length,
      threads: agents.reduce((acc, a) => acc + a.threadCount, 0),
      mcps: mcps.filter((m) => m.configured).length,
    },
  };
}

/**
 * Hard-delete ONE agent's artifacts: unregister its MCP servers from the
 * harness config, drop its workspace dir, and delete its sessions
 * (transcripts cascade). Goal rows are the caller's job
 * (`deleteGoalsForAgent`) — this module owns the filesystem/harness side.
 */
export async function cascadeDeleteAgentArtifacts(
  project_slug: string,
  agent_id: string,
): Promise<void> {
  const project = getProject(project_slug);
  const adapter = project ? requireAdapter(project.harness_adapter) : null;

  if (adapter) {
    const { GOALS_MCP_KEY, BROWSER_MCP_KEY } = await import(
      "@/server/mcp-server/registration"
    );
    const serverNames = [
      ...getMcpCatalog(project_slug).map((spec) => spec.key),
      GOALS_MCP_KEY,
      BROWSER_MCP_KEY,
    ];
    for (const serverName of serverNames) {
      try {
        await adapter.unregisterMcp({
          serverName,
          projectSlug: project_slug,
          agentId: agent_id,
        });
      } catch {
        // best-effort
      }
    }
  }

  try {
    await rm(workspaceDirFor(agent_id), { recursive: true, force: true });
  } catch (err) {
    console.error(`[delete] failed to rm workspace ${agent_id}:`, err);
  }

  getDb()
    .prepare("DELETE FROM sessions WHERE project_slug = ? AND agent_id = ?")
    .run(project_slug, agent_id);
}

/**
 * Hard-delete every artifact tied to a project that lives outside the
 * `projects` row's own FK cascade: agent workspace dirs, sessions +
 * transcripts, MCP tokens. The caller is expected to then call
 * `deleteProjectRow()` to drop the projects row itself.
 */
export async function cascadeDeleteProjectArtifacts(project_slug: string): Promise<void> {
  const project = getProject(project_slug);
  const adapter = project ? requireAdapter(project.harness_adapter) : null;
  const agents = await listProjectAgents(project_slug);

  // Stop the project's workspace browser first — its Chrome profile lives
  // under projects/<slug>/browser/, which the caller wipes; rm-ing a
  // user-data-dir under a live Chrome leaves an orphaned process behind.
  try {
    const { stopBrowser } = await import("@/server/browser/session");
    await stopBrowser(project_slug);
  } catch (err) {
    console.warn(`[delete] failed to stop workspace browser for ${project_slug}:`, err);
  }

  // Unregister any MCP servers the adapter wrote into its config (so codex
  // global config doesn't leak rows for deleted projects, and claude-code
  // workspaces don't reference dead bearers). This must cover the two
  // INTERNAL servers (goals + browser) that provisioning registers
  // for every agent, not just the external catalog — they used to be
  // skipped here and leaked [mcp_servers.notfair_<slug>__…] entries into
  // ~/.codex/config.toml for every deleted project.
  if (adapter) {
    const { GOALS_MCP_KEY, BROWSER_MCP_KEY } = await import(
      "@/server/mcp-server/registration"
    );
    const serverNames = [
      ...getMcpCatalog(project_slug).map((spec) => spec.key),
      GOALS_MCP_KEY,
      BROWSER_MCP_KEY,
    ];
    for (const agent of agents) {
      for (const serverName of serverNames) {
        try {
          await adapter.unregisterMcp({
            serverName,
            projectSlug: project_slug,
            agentId: agent.agent_id,
          });
        } catch {
          // best-effort
        }
      }
    }
  }

  // Drop workspace dirs.
  for (const agent of agents) {
    try {
      await rm(workspaceDirFor(agent.agent_id), { recursive: true, force: true });
    } catch (err) {
      console.error(`[delete] failed to rm workspace ${agent.agent_id}:`, err);
    }
  }

  // Drop sessions (transcript_events cascade).
  getDb()
    .prepare("DELETE FROM sessions WHERE project_slug = ?")
    .run(project_slug);

  // Drop MCP tokens.
  deleteProjectMcpTokens(project_slug);

  // Drop user-added MCP catalog entries for the project.
  getDb()
    .prepare("DELETE FROM user_mcp_servers WHERE project_slug = ?")
    .run(project_slug);
}
