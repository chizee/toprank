"use server";

import { revalidatePath } from "next/cache";

export type SetSkillEnabledResult = { ok: true } | { ok: false; error: string };

/**
 * Skills are inherent to the chosen harness adapter now (Claude Code skills,
 * Codex prompts, etc.) plus the SKILL.md notfair-cmo writes into each agent
 * workspace. There's no global enable/disable flag — agents always have
 * access to the SKILL.md their workspace contains.
 *
 * The action is preserved so the existing UI tile in the per-agent Skills
 * tab keeps compiling; clicks resolve immediately with no side effect.
 */
export async function setSkillEnabledAction(
  skillKey: string,
  _enabled: boolean,
  _agentSlug: string,
): Promise<SetSkillEnabledResult> {
  if (!skillKey) return { ok: false, error: "skillKey is required" };
  revalidatePath("/", "layout");
  return { ok: true };
}
