import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db/db";
import type { HarnessAdapterId } from "@/server/adapters/types";

/**
 * Session / thread management.
 *
 * A "session" is one chat thread between the user and an agent. Each agent
 * can have many sessions (named "main", "Q4 audit", etc.). The session id
 * is a stable NotFair UUID; we also store the adapter's own session id
 * (e.g. Claude Code's session UUID for resumption) when known.
 */
export interface Session {
  id: string;
  project_slug: string;
  agent_id: string;
  label: string;
  harness_adapter: HarnessAdapterId;
  harness_session_id: string | null;
  /** User-set display title (thread rename). Null = derive from content. */
  title: string | null;
  /** Set when the user pins the thread; doubles as pin-order tiebreaker. */
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptEvent {
  id: string;
  session_id: string;
  seq: number;
  kind: "user" | "delta" | "tool" | "lifecycle" | "final" | "error";
  payload_json: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  project_slug: string;
  agent_id: string;
  label: string;
  harness_adapter: string;
  harness_session_id: string | null;
  title: string | null;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: SessionRow): Session {
  return { ...row, harness_adapter: row.harness_adapter as HarnessAdapterId };
}

export function getOrCreateSession(input: {
  project_slug: string;
  agent_id: string;
  label: string;
  harness_adapter: HarnessAdapterId;
}): Session {
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM sessions WHERE project_slug = ? AND agent_id = ? AND label = ?",
    )
    .get(input.project_slug, input.agent_id, input.label) as SessionRow | undefined;
  if (existing) return rowToSession(existing);

  const session: Session = {
    id: randomUUID(),
    project_slug: input.project_slug,
    agent_id: input.agent_id,
    label: input.label,
    harness_adapter: input.harness_adapter,
    harness_session_id: null,
    title: null,
    pinned_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.prepare(
    "INSERT INTO sessions (id, project_slug, agent_id, label, harness_adapter, harness_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
  ).run(
    session.id,
    session.project_slug,
    session.agent_id,
    session.label,
    session.harness_adapter,
    session.created_at,
    session.updated_at,
  );
  return session;
}

/** Set / clear the user-facing display title (thread rename). */
export function setSessionTitle(id: string, title: string | null): void {
  getDb()
    .prepare("UPDATE sessions SET title = ? WHERE id = ?")
    .run(title?.trim() || null, id);
}

/** Pin or unpin a thread. */
export function setSessionPinned(id: string, pinned: boolean): void {
  getDb()
    .prepare("UPDATE sessions SET pinned_at = ? WHERE id = ?")
    .run(pinned ? new Date().toISOString() : null, id);
}

/**
 * Permanently delete a thread. transcript_events cascades on the FK, so
 * the whole conversation history goes with it.
 */
export function deleteSession(id: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/** The session for a (project, agent, label) triple, if one exists. */
export function findSession(
  project_slug: string,
  agent_id: string,
  label: string,
): Session | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM sessions WHERE project_slug = ? AND agent_id = ? AND label = ?",
    )
    .get(project_slug, agent_id, label) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function getSession(id: string): Session | null {
  const row = getDb()
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function listAgentSessions(project_slug: string, agent_id: string): Session[] {
  const rows = getDb()
    .prepare(
      // Pinned threads first (most recently pinned on top), then by
      // recency — the thread rail renders this order verbatim.
      "SELECT * FROM sessions WHERE project_slug = ? AND agent_id = ? ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, updated_at DESC",
    )
    .all(project_slug, agent_id) as SessionRow[];
  return rows.map(rowToSession);
}

export function touchSession(id: string, harness_session_id?: string): void {
  const now = new Date().toISOString();
  if (harness_session_id) {
    getDb()
      .prepare(
        "UPDATE sessions SET updated_at = ?, harness_session_id = COALESCE(harness_session_id, ?) WHERE id = ?",
      )
      .run(now, harness_session_id, id);
  } else {
    getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
  }
}

export function appendTranscriptEvent(
  session_id: string,
  kind: TranscriptEvent["kind"],
  payload: unknown,
): void {
  const db = getDb();
  const seqRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM transcript_events WHERE session_id = ?")
    .get(session_id) as { next: number };
  const id = randomUUID();
  const seq = seqRow.next;
  const created_at = new Date().toISOString();
  const payload_json = JSON.stringify(payload);
  db.prepare(
    "INSERT INTO transcript_events (id, session_id, seq, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, session_id, seq, kind, payload_json, created_at);
  // Push to live subscribers AFTER the INSERT commits. Best-effort: the
  // row is already persisted, so a publish failure must not throw into
  // the caller's adapter-event loop.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { publishSessionEvent } =
      require("@/server/live-events/emitter") as typeof import("@/server/live-events/emitter");
    publishSessionEvent(session_id, {
      id,
      session_id,
      seq,
      kind,
      payload_json,
      created_at,
    });
  } catch {
    // Live subscribers miss this event; the poll fallback still sees it.
  }
}

export function listTranscriptEvents(
  session_id: string,
  opts: { sinceSeq?: number; limit?: number } = {},
): TranscriptEvent[] {
  const limit = opts.limit ?? 1000;
  const since = opts.sinceSeq ?? 0;
  return getDb()
    .prepare(
      "SELECT * FROM transcript_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .all(session_id, since, limit) as TranscriptEvent[];
}
