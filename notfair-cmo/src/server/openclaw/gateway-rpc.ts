import { GatewayClient } from "./gateway-client";

/**
 * Thin wrappers around the OpenClaw gateway RPC methods we use from server
 * components. Each call opens a fresh GatewayClient, does one request, and
 * closes it. Per-request overhead is a single WS handshake to loopback (sub
 * 50ms on local), which is fine for SSR page loads where the alternative is
 * a multi-second `openclaw …` subprocess spawn.
 *
 * If we need higher-throughput access later, swap to a long-lived shared
 * client at process scope.
 */

async function withClient<T>(fn: (c: GatewayClient) => Promise<T>): Promise<T> {
  const client = new GatewayClient();
  await client.open();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

// --- agents.files ---

export type AgentFileEntry = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
};

export type AgentFilesList = {
  agentId: string;
  workspace: string;
  files: AgentFileEntry[];
};

export async function listAgentFiles(agentId: string): Promise<AgentFilesList> {
  return withClient((c) => c.request<AgentFilesList>("agents.files.list", { agentId }));
}

export type AgentFileGet = {
  agentId: string;
  workspace: string;
  file: AgentFileEntry & { content: string };
};

export async function getAgentFile(agentId: string, name: string): Promise<AgentFileGet> {
  return withClient((c) => c.request<AgentFileGet>("agents.files.get", { agentId, name }));
}

export async function setAgentFile(
  agentId: string,
  name: string,
  content: string,
): Promise<void> {
  await withClient((c) => c.request("agents.files.set", { agentId, name, content }));
}

// --- skills.status ---

export type SkillEntry = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  emoji?: string;
  always: boolean;
  disabled: boolean;
  eligible: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter: boolean;
  userInvocable: boolean;
  commandVisible: boolean;
  // Other fields exist (requirements, install) — leave as unknown until we
  // surface them in the UI.
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  agentId?: string;
  agentSkillFilter?: string[];
  skills: SkillEntry[];
};

export async function getSkillStatus(agentId: string): Promise<SkillStatusReport> {
  return withClient((c) =>
    c.request<SkillStatusReport>("skills.status", { agentId }),
  );
}

/**
 * Toggle a skill on/off in the workspace config. Requires operator.admin scope.
 * Affects all agents in the workspace (skills.config is workspace-wide).
 */
export async function setSkillEnabled(
  skillKey: string,
  enabled: boolean,
): Promise<void> {
  await withClient((c) =>
    c.request("skills.update", { skillKey, enabled }),
  );
}

// --- agents.delete ---

/**
 * Delete an agent from OpenClaw. With deleteFiles:true (default), removes the
 * workspace dir + sessions store so all thread history goes with it.
 * Requires operator.admin scope.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  await withClient((c) =>
    c.request("agents.delete", { agentId, deleteFiles: true }),
  );
}

// --- agents.list / agents.create ---

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    emoji?: string;
    avatar?: string;
  };
  model?: string;
};

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  agents: GatewayAgentRow[];
};

export async function listAllAgents(): Promise<AgentsListResult> {
  return withClient((c) => c.request<AgentsListResult>("agents.list", {}));
}

export type AgentCreateInput = {
  /** Full agentId, e.g. `<project>-<slug>`. */
  name: string;
  /** Absolute workspace directory. */
  workspace: string;
  model?: string;
  emoji?: string;
};

export async function createAgentViaRpc(input: AgentCreateInput): Promise<void> {
  await withClient((c) => c.request("agents.create", input));
}

// --- cron.update ---

/**
 * Replace a cron's agent-turn prompt. Other fields (schedule, agent target,
 * delivery) are left as-is. Requires operator.admin scope.
 */
export async function updateCronMessage(cron_id: string, message: string): Promise<void> {
  await withClient((c) =>
    c.request("cron.update", {
      id: cron_id,
      patch: {
        payload: { kind: "agentTurn", message },
      },
    }),
  );
}

