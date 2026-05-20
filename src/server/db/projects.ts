import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { Project } from "@/types";
import { slugify } from "@/lib/slug";

export type CreateProjectInput = {
  display_name: string;
  slug?: string;
};

export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; reason: string };

export function listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
  const db = getDb();
  const sql = opts.includeArchived
    ? "SELECT * FROM projects ORDER BY created_at DESC"
    : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC";
  return db.prepare(sql).all() as Project[];
}

export function getProject(slug: string): Project | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug);
  return (row as Project) ?? null;
}

export function createProject(input: CreateProjectInput): CreateProjectResult {
  const db = getDb();
  const slugInput = input.slug ?? input.display_name;
  const slug = slugify(slugInput);
  if (!slug.ok) return { ok: false, reason: slug.reason };

  const existing = db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug.slug);
  if (existing) return { ok: false, reason: `project slug '${slug.slug}' already exists` };

  const project: Project = {
    id: randomUUID(),
    slug: slug.slug,
    display_name: input.display_name.trim(),
    created_at: new Date().toISOString(),
    archived_at: null,
    google_ads_account_id: null,
  };

  db.prepare(
    "INSERT INTO projects (id, slug, display_name, created_at, archived_at, google_ads_account_id) VALUES (?, ?, ?, ?, NULL, NULL)",
  ).run(project.id, project.slug, project.display_name, project.created_at);

  return { ok: true, project };
}

/**
 * Persist the chosen Google Ads customer ID for a project. Returns null when
 * the project doesn't exist or is archived. Idempotent — re-setting to the
 * same value is a no-op write.
 */
export function setProjectGoogleAdsAccount(
  slug: string,
  account_id: string | null,
): Project | null {
  const db = getDb();
  const existing = db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug);
  if (!existing) return null;
  db.prepare("UPDATE projects SET google_ads_account_id = ? WHERE slug = ?").run(
    account_id,
    slug,
  );
  return getProject(slug);
}

export function renameProject(slug: string, display_name: string): Project | null {
  const db = getDb();
  const trimmed = display_name.trim();
  if (!trimmed) return null;
  db.prepare("UPDATE projects SET display_name = ? WHERE slug = ?").run(trimmed, slug);
  return getProject(slug);
}

/**
 * Migrate every DB row keyed off `project_slug` from `old` to `new`. Wraps
 * the updates in a transaction with `defer_foreign_keys=ON` so the
 * referential checks happen at COMMIT instead of per-row — required because
 * our FKs reference `projects(slug)` without `ON UPDATE CASCADE`.
 *
 * Returns the renamed project, or null when the old slug doesn't exist.
 */
export function changeProjectSlug(
  old_slug: string,
  new_slug: string,
  new_display_name?: string,
): Project | null {
  const db = getDb();
  if (old_slug === new_slug) {
    if (new_display_name) {
      db.prepare("UPDATE projects SET display_name = ? WHERE slug = ?").run(
        new_display_name.trim(),
        old_slug,
      );
    }
    return getProject(old_slug);
  }
  // Bail if the source doesn't exist or the destination already exists.
  if (!db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(old_slug)) {
    return null;
  }
  if (db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(new_slug)) {
    throw new Error(`Project slug '${new_slug}' already exists`);
  }

  const childTables = [
    "tasks",
    "approvals",
    "cost_events",
    "oauth_tokens",
    "agent_actions",
    "sequence_runs",
  ];

  // Disable FK enforcement for the duration of the rename. Our FKs reference
  // `projects(slug)` without ON UPDATE CASCADE, so updating the PK while
  // child rows still point at the old value would violate. `defer_foreign_keys`
  // inside a wrapped transaction doesn't take effect reliably across SQLite
  // releases; toggling `foreign_keys` is universally supported and works the
  // same way every popular SQLite migration tool uses.
  const fkWasOn = db.pragma("foreign_keys = OFF", { simple: true });
  try {
    const tx = db.transaction(() => {
      for (const table of childTables) {
        try {
          db.prepare(`UPDATE ${table} SET project_slug = ? WHERE project_slug = ?`).run(
            new_slug,
            old_slug,
          );
        } catch {
          // table missing on this install; skip.
        }
      }
      if (new_display_name) {
        db.prepare("UPDATE projects SET slug = ?, display_name = ? WHERE slug = ?").run(
          new_slug,
          new_display_name.trim(),
          old_slug,
        );
      } else {
        db.prepare("UPDATE projects SET slug = ? WHERE slug = ?").run(new_slug, old_slug);
      }
    });
    tx();
  } finally {
    // Restore prior FK state (1 if it was on, 0 if it was already off).
    db.pragma(`foreign_keys = ${fkWasOn === 0 ? "OFF" : "ON"}`);
  }

  return getProject(new_slug);
}

export function archiveProject(slug: string): Project | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET archived_at = ? WHERE slug = ? AND archived_at IS NULL").run(now, slug);
  return getProject(slug);
}

export function unarchiveProject(slug: string): Project | null {
  const db = getDb();
  db.prepare("UPDATE projects SET archived_at = NULL WHERE slug = ?").run(slug);
  return getProject(slug);
}

/**
 * Hard-delete a project row plus any rows in tables that key off
 * project_slug. OpenClaw-side state — agents, sessions, crons — is cleaned
 * up by the deleteProject orchestrator, not here.
 *
 * MUST match the FK-bearing tables from the migrations (mirrored exactly by
 * the changeProjectSlug helper above). Adding a new migration that FKs to
 * projects(slug) requires adding the table name here too — otherwise delete
 * trips a SqliteError FOREIGN KEY constraint failed (the bug we just
 * shipped a regression test for).
 */
export function deleteProjectRow(slug: string): void {
  const db = getDb();
  const childTables = [
    "tasks",
    "approvals",
    "cost_events",
    "oauth_tokens",
    "agent_actions",
    "sequence_runs",
  ];
  for (const table of childTables) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE project_slug = ?`).run(slug);
    } catch {
      // table missing on this install (e.g., older DB pre-migration).
      // Per-table try/catch so one missing table doesn't block the rest.
    }
  }
  db.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
}
