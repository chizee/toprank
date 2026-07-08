import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listCodexModels } from "./models";

async function writeCache(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-models-"));
  const file = join(dir, "models_cache.json");
  await writeFile(
    file,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return file;
}

describe("listCodexModels", () => {
  it("maps visible models from the provider cache, sorted by priority", async () => {
    const file = await writeCache({
      models: [
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 16 },
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 7 },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
        { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "list", priority: 23 },
      ],
    });
    expect(await listCodexModels(file)).toEqual([
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    ]);
  });

  it("falls back to slug when display_name is missing", async () => {
    const file = await writeCache({
      models: [{ slug: "gpt-9", visibility: "list", priority: 1 }],
    });
    expect(await listCodexModels(file)).toEqual([
      { value: "gpt-9", label: "gpt-9" },
    ]);
  });

  it("returns the static fallback when the cache file is missing", async () => {
    const models = await listCodexModels("/nonexistent/models_cache.json");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.value).toBe("gpt-5.5");
  });

  it("returns the static fallback on malformed JSON or an empty list", async () => {
    expect(await listCodexModels(await writeCache("not-json{{{"))).toEqual(
      await listCodexModels("/nonexistent"),
    );
    expect(await listCodexModels(await writeCache({ models: [] }))).toEqual(
      await listCodexModels("/nonexistent"),
    );
  });
});
