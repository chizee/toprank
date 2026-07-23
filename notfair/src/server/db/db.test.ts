import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Real better-sqlite3 against a tmpdir DB, per repo test conventions.
// MUST be hoisted: db.ts captures NOTFAIR_DATA_DIR at import time, so a
// plain assignment would point the suite at the developer's live ~/.notfair.
const h = vi.hoisted(() => {
  const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dataDir = mkdtempSync(join(tmpdir(), "notfair-db-"));
  // getDb creates the data dir itself when missing — exercise that path.
  rmSync(dataDir, { recursive: true, force: true });
  process.env.NOTFAIR_DATA_DIR = dataDir;
  return { dataDir };
});

import { getDb, getDbPath } from "./db";

describe("getDb", () => {
  it("creates the data dir + db file and applies the schema", () => {
    expect(existsSync(h.dataDir)).toBe(false);
    const db = getDb();
    expect(existsSync(join(h.dataDir, "db.sqlite"))).toBe(true);
    // Schema applied: core tables exist.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("projects");
    expect(names).toContain("sessions");
    expect(names).toContain("transcript_events");
    const tickColumns = db.pragma("table_info(goal_ticks)") as Array<{
      name: string;
    }>;
    expect(tickColumns.map((column) => column.name)).toContain("owner_pid");
  });

  it("configures WAL journaling and foreign keys", () => {
    const db = getDb();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("caches the connection — repeated calls return the same instance", () => {
    expect(getDb()).toBe(getDb());
  });
});

describe("getDbPath", () => {
  it("points at db.sqlite inside the data dir", () => {
    expect(getDbPath()).toBe(join(h.dataDir, "db.sqlite"));
  });
});
