import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real better-sqlite3 against a tmpdir DB. MUST be hoisted before imports.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.NOTFAIR_DATA_DIR = mkdtempSync(join(tmpdir(), "notfair-db-suggestions-"));
});

import { getDb } from "@/server/db/db";
import {
  getSuggestion,
  hasSuggestionsForSource,
  listOpenSuggestions,
  markSuggestionAccepted,
  markSuggestionDismissed,
  replaceOpenSuggestions,
  type SuggestionDraft,
} from "./suggestions";

const SLUG = "sugproj";

function seedProject(slug: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO projects (id, slug, display_name, created_at, harness_adapter) VALUES (?, ?, ?, ?, 'claude-code-local')",
    )
    .run(slug, slug, slug, new Date().toISOString());
}

function draft(kind: string, over: Partial<SuggestionDraft> = {}): SuggestionDraft {
  return {
    kind,
    title: `title-${kind}`,
    statement: `statement-${kind}`,
    mode: "achieve",
    rationale: `rationale-${kind}`,
    ...over,
  };
}

beforeAll(() => {
  seedProject(SLUG);
});

beforeEach(() => {
  getDb().prepare("DELETE FROM goal_suggestions WHERE project_slug = ?").run(SLUG);
});

describe("replaceOpenSuggestions", () => {
  it("inserts a fresh batch of open rows", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1"), draft("k2")]);
    const rows = listOpenSuggestions(SLUG);
    expect(rows.map((r) => r.kind).sort()).toEqual(["k1", "k2"]);
    expect(rows[0]!.status).toBe("open");
  });

  it("refreshes an open row in place on conflict (same kind)", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1", { title: "first" })]);
    const before = listOpenSuggestions(SLUG)[0]!;
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1", { title: "second" })]);
    const after = getSuggestion(before.id)!;
    expect(after.id).toBe(before.id); // same row, updated in place
    expect(after.title).toBe("second");
  });

  it("deletes open rows whose kind is absent from the new batch", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1"), draft("k2")]);
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1")]);
    expect(listOpenSuggestions(SLUG).map((r) => r.kind)).toEqual(["k1"]);
  });

  it("deletes all open rows for the source when the batch is empty", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1"), draft("k2")]);
    replaceOpenSuggestions(SLUG, "src-a", []);
    expect(listOpenSuggestions(SLUG)).toEqual([]);
  });

  it("never touches accepted or dismissed rows", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1"), draft("k2")]);
    const rows = listOpenSuggestions(SLUG);
    const accepted = rows.find((r) => r.kind === "k1")!;
    const dismissed = rows.find((r) => r.kind === "k2")!;
    markSuggestionAccepted(accepted.id, "goal-x");
    markSuggestionDismissed(dismissed.id);

    // A regen with neither kind must not delete the terminal rows, and the
    // ON CONFLICT WHERE status='open' guard must not resurrect them.
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1"), draft("k2")]);

    expect(getSuggestion(accepted.id)!.status).toBe("accepted");
    expect(getSuggestion(accepted.id)!.accepted_goal_id).toBe("goal-x");
    expect(getSuggestion(dismissed.id)!.status).toBe("dismissed");
    // The fresh batch only produced open rows for kinds that were free.
    expect(listOpenSuggestions(SLUG)).toEqual([]);
  });

  it("scopes deletes to (project, source)", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1")]);
    replaceOpenSuggestions(SLUG, "src-b", [draft("k1")]);
    replaceOpenSuggestions(SLUG, "src-a", []); // clears only src-a
    expect(listOpenSuggestions(SLUG).map((r) => r.source_key)).toEqual(["src-b"]);
  });
});

describe("listOpenSuggestions", () => {
  it("orders by created_at then kind and only returns open rows", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("b"), draft("a")]);
    const open = listOpenSuggestions(SLUG);
    // Same created_at → tiebreak on kind ASC.
    expect(open.map((r) => r.kind)).toEqual(["a", "b"]);
  });
});

describe("getSuggestion", () => {
  it("returns null for an unknown id", () => {
    expect(getSuggestion("nope")).toBeNull();
  });
});

describe("hasSuggestionsForSource", () => {
  it("is true once any row exists (even after acceptance) and false otherwise", () => {
    expect(hasSuggestionsForSource(SLUG, "src-a")).toBe(false);
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1")]);
    expect(hasSuggestionsForSource(SLUG, "src-a")).toBe(true);
    const row = listOpenSuggestions(SLUG)[0]!;
    markSuggestionDismissed(row.id);
    expect(hasSuggestionsForSource(SLUG, "src-a")).toBe(true);
    expect(hasSuggestionsForSource(SLUG, "other-src")).toBe(false);
  });
});

describe("markSuggestionAccepted / markSuggestionDismissed", () => {
  it("stamps status and accepted_goal_id", () => {
    replaceOpenSuggestions(SLUG, "src-a", [draft("k1")]);
    const row = listOpenSuggestions(SLUG)[0]!;
    markSuggestionAccepted(row.id, "goal-42");
    const after = getSuggestion(row.id)!;
    expect(after.status).toBe("accepted");
    expect(after.accepted_goal_id).toBe("goal-42");
    expect(after.updated_at >= after.created_at).toBe(true);
  });
});
