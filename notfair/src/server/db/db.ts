import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema";

const DEFAULT_DATA_DIR = process.env.NOTFAIR_DATA_DIR ?? join(homedir(), ".notfair");
const DB_PATH = join(DEFAULT_DATA_DIR, "db.sqlite");

let cached: Database.Database | null = null;

export function getDb(): Database.Database {
  if (cached) return cached;

  if (!existsSync(DEFAULT_DATA_DIR)) {
    mkdirSync(DEFAULT_DATA_DIR, { recursive: true, mode: 0o700 });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(SCHEMA);
  ensureGoalTickOwnerColumn(db);

  cached = db;
  return db;
}

export function getDbPath(): string {
  return DB_PATH;
}

function ensureGoalTickOwnerColumn(db: Database.Database): void {
  const hasOwnerPid = () =>
    (
      db.pragma("table_info(goal_ticks)") as Array<{ name: string }>
    ).some((column) => column.name === "owner_pid");
  if (hasOwnerPid()) return;

  try {
    db.exec("ALTER TABLE goal_ticks ADD COLUMN owner_pid INTEGER");
  } catch (error) {
    // Two local processes can open the same data directory concurrently.
    // Treat a raced migration as success only when the other process
    // actually installed the column.
    if (!hasOwnerPid()) throw error;
  }
}
