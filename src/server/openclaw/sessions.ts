import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { agentNameFor, type AgentTemplateKey } from "@/server/agent-templates";

/**
 * Sessions are owned by OpenClaw. We never persist threads, history, or
 * session metadata ourselves. We only:
 *   1. Read OpenClaw's session store (`~/.openclaw/agents/<agent>/sessions/sessions.json`)
 *      to list a user's existing sessions for the chat thread dropdown.
 *   2. Generate fresh UUIDs to start new sessions (OpenClaw creates the session
 *      entry on the first agent turn).
 *   3. Remember the active session per (project, agent_template) in a cookie.
 *
 * No DB table, no migrations, no ownership of session lifecycle.
 */

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");

export type OpenClawSession = {
  /** OpenClaw-assigned session id (UUID). What we pass to --session-id. */
  sessionId: string;
  /** Optional short label parsed from the full session-key, if present. */
  label: string;
  /**
   * Full sessionKey OpenClaw uses internally (`agent:<agent>:<label>`). The
   * label half is the canonical identifier for an existing thread — OpenClaw
   * may register `<main>` for its bootstrap thread instead of the sessionId.
   * For brand-new threads we create, the label IS the sessionId UUID.
   */
  sessionKey: string;
  /** Last interaction (ms epoch). 0 if unknown / freshly minted. */
  lastInteractionAt: number;
  /** True if this session exists only in our cookie (user clicked New, hasn't sent a message yet). */
  pending: boolean;
};

type RawSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  lastInteractionAt?: number;
};

function sessionsFilePath(agentFullId: string): string {
  return join(OPENCLAW_HOME, "agents", agentFullId, "sessions", "sessions.json");
}

export function listSessionsForAgent(agentFullId: string): OpenClawSession[] {
  const path = sessionsFilePath(agentFullId);
  if (!existsSync(path)) return [];
  let parsed: Record<string, RawSessionEntry>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, RawSessionEntry>;
  } catch {
    return [];
  }
  const prefix = `agent:${agentFullId}:`;
  const out: OpenClawSession[] = [];
  for (const [key, entry] of Object.entries(parsed)) {
    if (!entry.sessionId) continue;
    const label = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    out.push({
      sessionId: entry.sessionId,
      label,
      sessionKey: key,
      lastInteractionAt: entry.lastInteractionAt ?? entry.updatedAt ?? 0,
      pending: false,
    });
  }
  out.sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);
  return out;
}

/**
 * Build the canonical sessionKey for a brand-new thread we're about to send
 * the first message to. Label = the same UUID we're using as sessionId, so
 * the thread becomes self-identifying in OpenClaw's store.
 */
export function buildPendingSessionKey(agentFullId: string, sessionId: string): string {
  return `agent:${agentFullId}:${sessionId}`;
}

/**
 * Look up an existing session by the URL thread id we mint for new chats.
 *
 * That id ends up as the **label** part of OpenClaw's sessionKey
 * (`agent:<agent>:<label>`), not as OpenClaw's internal `sessionId` — which is
 * a different UUID the gateway assigns when it first writes the transcript
 * file. So we match on label first, falling back to sessionId for the older
 * case where the two happened to coincide.
 *
 * Returns null when the thread id is unknown to OpenClaw — caller should
 * treat it as a pending new thread.
 */
export function findSessionBySessionId(
  agentFullId: string,
  threadId: string,
): OpenClawSession | null {
  const all = listSessionsForAgent(agentFullId);
  return (
    all.find((s) => s.label === threadId) ??
    all.find((s) => s.sessionId === threadId) ??
    null
  );
}

/** Generate a brand-new session id. OpenClaw creates the entry on first turn. */
export function newSessionId(): string {
  return randomUUID();
}

// --- Active session per (project, agent-template) is just a cookie. ---

function cookieName(project_slug: string, agent_template_key: string): string {
  return `notfair_active_session_${project_slug}_${agent_template_key}`;
}

/**
 * Return the active session for (project, agent_template) along with the
 * full list of sessions in dropdown order. If the cookie points at a UUID
 * not yet in OpenClaw's store (pending first-message), it appears at the top
 * as a synthetic entry tagged pending.
 */
export async function getSessionsView(
  project_slug: string,
  agent_template_key: AgentTemplateKey,
): Promise<{ active: OpenClawSession; all: OpenClawSession[] }> {
  const agentFullId = agentNameFor(project_slug, agent_template_key);
  const existing = listSessionsForAgent(agentFullId);

  const c = await cookies();
  const cookieSessionId = c.get(cookieName(project_slug, agent_template_key))?.value;

  let active: OpenClawSession | undefined;
  if (cookieSessionId) {
    active = existing.find((s) => s.sessionId === cookieSessionId);
    if (!active) {
      active = {
        sessionId: cookieSessionId,
        label: cookieSessionId.slice(0, 8),
        sessionKey: buildPendingSessionKey(agentFullId, cookieSessionId),
        lastInteractionAt: 0,
        pending: true,
      };
    }
  }

  if (!active) {
    if (existing.length > 0) {
      active = existing[0]!;
    } else {
      // No history yet — synthesize a default session id. Cookie will be set
      // when the user sends their first message.
      const newId = newSessionId();
      active = {
        sessionId: newId,
        label: "main",
        sessionKey: buildPendingSessionKey(agentFullId, newId),
        lastInteractionAt: 0,
        pending: true,
      };
    }
  }

  const all = active.pending && !existing.find((s) => s.sessionId === active!.sessionId)
    ? [active, ...existing]
    : existing;

  return { active, all };
}

export async function setActiveSession(
  project_slug: string,
  agent_template_key: AgentTemplateKey,
  sessionId: string,
): Promise<void> {
  const c = await cookies();
  c.set(cookieName(project_slug, agent_template_key), sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
