import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessModelOption } from "../types";
import { codexConfigDir } from "./mcp";

/**
 * Model discovery for Codex — read the PROVIDER's list, don't hardcode.
 *
 * The codex CLI has no "list models" command, but its TUI fetches the
 * account-scoped model list from OpenAI and caches it at
 * `~/.codex/models_cache.json` (slug, display_name, visibility,
 * priority, …). We read that cache: it's the same source the user's own
 * `/model` picker shows, refreshed whenever they run codex.
 *
 * Entries with `visibility: "hide"` are internal (e.g. codex-auto-review)
 * and excluded. Sorted by the cache's own `priority` (ascending — that's
 * the order the TUI shows).
 *
 * Fallback: when the cache is missing/unreadable (fresh install that has
 * never run the TUI), return a minimal static list so the selector still
 * works. Never throws.
 */

type CachedModel = {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
};

const FALLBACK: HarnessModelOption[] = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
];

export async function listCodexModels(
  cacheFile: string = join(codexConfigDir(), "models_cache.json"),
): Promise<HarnessModelOption[]> {
  try {
    const raw = await readFile(cacheFile, "utf8");
    const parsed = JSON.parse(raw) as { models?: CachedModel[] };
    const models = (parsed.models ?? [])
      .filter(
        (m): m is CachedModel & { slug: string } =>
          typeof m.slug === "string" &&
          m.slug.length > 0 &&
          m.visibility !== "hide",
      )
      .sort(
        (a, b) =>
          (typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER) -
          (typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER),
      )
      .map<HarnessModelOption>((m) => ({
        value: m.slug,
        label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
      }));
    return models.length > 0 ? models : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
