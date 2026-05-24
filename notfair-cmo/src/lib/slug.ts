const RESERVED_SLUGS = new Set([
  "api",
  "app",
  "auth",
  "admin",
  "system",
  "settings",
  "cron",
  "agent",
  "agents",
  "cmo",
  "notfair",
  "openclaw",
]);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SlugResult =
  | { ok: true; slug: string }
  | { ok: false; reason: string };

export function slugify(input: string, maxLen = 40): SlugResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "input is empty" };

  const ascii = trimmed
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!ascii) return { ok: false, reason: "no valid characters" };

  const capped = ascii.slice(0, maxLen).replace(/-+$/g, "");

  if (!SLUG_PATTERN.test(capped)) {
    return { ok: false, reason: "result does not match slug pattern" };
  }

  if (RESERVED_SLUGS.has(capped)) {
    return { ok: false, reason: `'${capped}' is reserved` };
  }

  return { ok: true, slug: capped };
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}
