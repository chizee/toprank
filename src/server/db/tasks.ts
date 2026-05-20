import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { Task, TaskStatus } from "@/types";

export type CreateTaskInput = {
  project_slug: string;
  /** Assignee — the agent expected to do the work. */
  agent_id: string;
  /** Short label for the kanban card. Optional but recommended. */
  title?: string | null;
  brief: string;
  success_criteria?: string | null;
  deadline_iso?: string | null;
  status?: TaskStatus;
  /** Agent that created this task. CMO is the typical originator. */
  assigner_agent_id?: string | null;
};

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    project_slug: input.project_slug,
    agent_id: input.agent_id,
    title: input.title ?? null,
    brief: input.brief,
    success_criteria: input.success_criteria ?? null,
    deadline_iso: input.deadline_iso ?? null,
    status: input.status ?? "proposed",
    result_json: null,
    error_message: null,
    thread_id: null,
    assigner_agent_id: input.assigner_agent_id ?? null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO tasks
       (id, project_slug, agent_id, title, brief, success_criteria, deadline_iso,
        status, result_json, error_message, thread_id, assigner_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    task.id,
    task.project_slug,
    task.agent_id,
    task.title,
    task.brief,
    task.success_criteria,
    task.deadline_iso,
    task.status,
    task.assigner_agent_id,
    task.created_at,
    task.updated_at,
  );
  return task;
}

/**
 * Lazily set the OpenClaw chat session id for this task. Called the first
 * time someone opens /tasks/[id] — the thread_id is generated then and
 * remains stable forever after so the per-task chat history persists.
 * No-op when the task already has a thread_id assigned.
 */
export function setTaskThreadIfMissing(
  id: string,
  thread_id: string,
): Task | null {
  const db = getDb();
  const current = getTask(id);
  if (!current) return null;
  if (current.thread_id) return current;
  db.prepare(
    "UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ? AND thread_id IS NULL",
  ).run(thread_id, new Date().toISOString(), id);
  return getTask(id);
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return (row as Task) ?? null;
}

export function listTasks(project_slug: string, status?: TaskStatus): Task[] {
  const db = getDb();
  if (status) {
    return db
      .prepare("SELECT * FROM tasks WHERE project_slug = ? AND status = ? ORDER BY created_at DESC")
      .all(project_slug, status) as Task[];
  }
  return db
    .prepare("SELECT * FROM tasks WHERE project_slug = ? ORDER BY created_at DESC")
    .all(project_slug) as Task[];
}

/**
 * Per-agent task list — what's on this agent's plate. Used by the
 * /agents/[agent]/tasks page so the assignee can see its queue without
 * filtering the project-wide kanban manually.
 */
export function listTasksByAgent(agent_id: string, status?: TaskStatus): Task[] {
  const db = getDb();
  if (status) {
    return db
      .prepare("SELECT * FROM tasks WHERE agent_id = ? AND status = ? ORDER BY created_at DESC")
      .all(agent_id, status) as Task[];
  }
  return db
    .prepare("SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC")
    .all(agent_id) as Task[];
}

export type UpdateTaskInput = {
  status?: TaskStatus;
  result?: unknown;
  error_message?: string | null;
};

export function updateTask(id: string, update: UpdateTaskInput): Task | null {
  const db = getDb();
  const now = new Date().toISOString();
  const current = getTask(id);
  if (!current) return null;

  const result_json = update.result !== undefined ? JSON.stringify(update.result) : current.result_json;
  const error_message = update.error_message !== undefined ? update.error_message : current.error_message;
  const status = update.status ?? current.status;

  db.prepare(
    "UPDATE tasks SET status = ?, result_json = ?, error_message = ?, updated_at = ? WHERE id = ?",
  ).run(status, result_json, error_message, now, id);

  return getTask(id);
}
