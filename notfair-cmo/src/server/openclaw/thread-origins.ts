import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { listTasksByAgent } from "@/server/db/tasks";
import { listCronsForProject } from "./crons";
import type { OpenClawSession } from "./sessions";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");

/**
 * What spawned a chat thread. Used by the thread dropdown to label each row
 * with something meaningful — a task's display_id, a cron's short name, or
 * the first user message of a free-form chat — instead of an opaque UUID.
 */
export type SessionOrigin =
  | { kind: "task"; display_id: string; title: string | null }
  | { kind: "cron"; cron_name: string }
  | { kind: "chat"; preview: string };

/** OpenClaw cron-run session labels are `cron:<jobId>:run:<runSessionId>`. */
const CRON_LABEL_PREFIX = "cron:";

/**
 * True when the session belongs to a kanban task (label matches a task's
 * `thread_id`) or a cron run (label starts with `cron:`). Used by the chat
 * landing redirect to skip those rows so the user lands on a free-form
 * chat instead of a task workspace.
 */
export function isTaskOrCronSession(
  label: string,
  taskThreadIds: ReadonlySet<string>,
): boolean {
  return label.startsWith(CRON_LABEL_PREFIX) || taskThreadIds.has(label);
}

/**
 * Pick the most-recent free-form chat session (skipping task + cron rows).
 * Assumes `sessions` is already sorted newest-first, which is the order
 * `listSessionsForAgent` returns. Returns `undefined` when no chat exists.
 */
export function pickLatestChatSession<
  S extends { label: string },
>(sessions: readonly S[], taskThreadIds: ReadonlySet<string>): S | undefined {
  return sessions.find((s) => !isTaskOrCronSession(s.label, taskThreadIds));
}
const PREVIEW_MAX_CHARS = 40;
/**
 * Cap the file read used to find a chat thread's first user message. The
 * first message is always at the top of the JSONL; 32 KB is enough to span
 * the session header + first message + slack, without dragging in the full
 * transcript (which can run into MB on a long chat).
 */
const FIRST_MESSAGE_PROBE_BYTES = 32 * 1024;

/**
 * Classify each session by origin so the dropdown can show meaningful labels.
 * Tasks come from the project DB (`tasks.thread_id === session.label`); crons
 * come from OpenClaw's cron list keyed by jobId parsed out of the label; free
 * chats fall back to a preview of the first user message in the JSONL.
 *
 * Returns a map keyed by session label (the part after `agent:<id>:`). Pending
 * sessions are skipped — they have no transcript yet and no kanban/cron link.
 */
export async function classifySessions(
  agentFullId: string,
  projectSlug: string,
  sessions: OpenClawSession[],
): Promise<Map<string, SessionOrigin>> {
  const out = new Map<string, SessionOrigin>();
  if (sessions.length === 0) return out;

  const cronJobIds = new Set<string>();
  const chatLikeLabels: string[] = [];
  for (const s of sessions) {
    if (s.pending) continue;
    if (s.label.startsWith(CRON_LABEL_PREFIX)) {
      const jobId = s.label.split(":")[1];
      if (jobId) cronJobIds.add(jobId);
    } else {
      chatLikeLabels.push(s.label);
    }
  }

  // Tasks — one DB read for the agent's queue, then a map lookup per session.
  const taskByThread = new Map<
    string,
    { display_id: string; title: string | null }
  >();
  if (chatLikeLabels.length > 0) {
    const tasks = listTasksByAgent(agentFullId);
    for (const t of tasks) {
      if (t.thread_id) {
        taskByThread.set(t.thread_id, {
          display_id: t.display_id,
          title: t.title,
        });
      }
    }
  }

  // Crons — only hit the cron list if at least one label looks cron-shaped.
  const cronByJobId = new Map<string, string>();
  if (cronJobIds.size > 0) {
    const view = await listCronsForProject(projectSlug);
    for (const g of view.groups) {
      for (const c of g.crons) {
        cronByJobId.set(c.id, c.short_name || c.name);
      }
    }
  }

  for (const s of sessions) {
    if (s.pending) continue;
    if (s.label.startsWith(CRON_LABEL_PREFIX)) {
      const jobId = s.label.split(":")[1] ?? "";
      const name = cronByJobId.get(jobId);
      out.set(s.label, {
        kind: "cron",
        cron_name: name ?? `cron · ${jobId.slice(0, 8)}`,
      });
      continue;
    }
    const task = taskByThread.get(s.label);
    if (task) {
      out.set(s.label, {
        kind: "task",
        display_id: task.display_id,
        title: task.title,
      });
      continue;
    }
    out.set(s.label, {
      kind: "chat",
      preview: readFirstUserMessagePreview(agentFullId, s.sessionId),
    });
  }
  return out;
}

/**
 * Peek at a session's JSONL transcript and return a short preview of the
 * first user message. Reads only the first ~32 KB rather than the full file
 * — the first user turn is always at the top, and long transcripts can run
 * into the MBs.
 */
function readFirstUserMessagePreview(
  agentFullId: string,
  sessionId: string,
): string {
  const path = join(
    OPENCLAW_HOME,
    "agents",
    agentFullId,
    "sessions",
    `${sessionId}.jsonl`,
  );
  if (!existsSync(path)) return "";
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  let raw: string;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, FIRST_MESSAGE_PROBE_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    raw = buf.toString("utf8");
  } catch {
    return "";
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore — closing a stale fd shouldn't break the dropdown.
    }
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "user") continue;
    const text = extractText(msg.content);
    if (text) return shorten(stripUserTimestampPrefix(text));
  }
  return "";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") parts.push(c);
    else if (c && typeof c === "object") {
      const obj = c as { type?: string; text?: string };
      if (obj.type === "text" && typeof obj.text === "string") {
        parts.push(obj.text);
      }
    }
  }
  return parts.join(" ");
}

// Same shape as transcript-tail.stripUserTimestampPrefix — keeps the preview
// from leading with the bracketed timestamp OpenClaw prepends to user turns.
function stripUserTimestampPrefix(s: string): string {
  return s.replace(
    /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{2,5}\] ?/,
    "",
  );
}

function shorten(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_MAX_CHARS) return flat;
  return flat.slice(0, PREVIEW_MAX_CHARS - 1) + "…";
}
