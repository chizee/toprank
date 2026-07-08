import type { HarnessModelOption } from "../types";

/**
 * Model listing for Claude Code.
 *
 * Unlike codex there is no provider-fed cache to read: the claude CLI
 * exposes no "list models" command, and its account-scoped picker state
 * isn't persisted anywhere stable. What IS stable is the CLI's alias
 * surface — `claude --help` documents tier aliases that always resolve
 * to the newest model of each tier, so this list doesn't go stale on
 * point releases. Revisit if the CLI ever ships model enumeration.
 */
const ALIAS_TIERS: HarnessModelOption[] = [
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

export async function listClaudeCodeModels(): Promise<HarnessModelOption[]> {
  return ALIAS_TIERS;
}
