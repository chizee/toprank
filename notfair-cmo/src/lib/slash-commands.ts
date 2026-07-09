/**
 * Slash command catalog + local executor.
 *
 * Every command here is handled CLIENT-SIDE by the chat composer. The
 * catalog used to carry ~17 more entries ported from OpenClaw's web UI
 * (/compact, /status, /elevated, /queue, …) marked "pass through to the
 * agent" — but notfair-cmo no longer runs on OpenClaw, and neither
 * `claude -p` nor `codex exec` interprets slash commands in the prompt,
 * so those rows just sent literal "/compact" text to the agent. The
 * catalog now lists only commands that actually do something.
 */

export type SlashCommandCategory = "session" | "model" | "status";

export type SlashCommand = {
  /** Canonical key. */
  key: string;
  /** Display name (without the leading slash). */
  name: string;
  /** Short description shown in the menu. */
  description: string;
  /** Optional argument hint shown beside the name. */
  args?: string;
  category: SlashCommandCategory;
  /** All current commands run locally; kept for the popover's grouping. */
  executeLocal: true;
  /** Text inserted into the textarea when the user picks this. Defaults to `/${name} `. */
  insert?: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    key: "clear",
    name: "clear",
    description: "Clear the visible chat buffer (trajectory on disk is kept).",
    category: "session",
    executeLocal: true,
  },
  {
    key: "new",
    name: "new",
    description: "Start a new chat (creates a fresh thread).",
    category: "session",
    executeLocal: true,
  },
  {
    key: "stop",
    name: "stop",
    description: "Stop the in-flight response.",
    category: "session",
    executeLocal: true,
  },
  {
    key: "model",
    name: "model",
    description:
      "Set the model override for this chat (same as the selector next to Send). No argument shows the options; `default` resets.",
    args: "<model>",
    category: "model",
    executeLocal: true,
    insert: "/model ",
  },
  {
    key: "help",
    name: "help",
    description: "Show available commands.",
    category: "status",
    executeLocal: true,
  },
];

/**
 * Filter commands by what the user has typed after the leading `/`.
 * Prefix match wins; substring is a fallback so `/od` still finds /model.
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q || q === "/") return SLASH_COMMANDS;
  const stripped = q.startsWith("/") ? q.slice(1) : q;
  const exact = SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(stripped));
  if (exact.length > 0) return exact;
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(stripped));
}

/**
 * Parse a chat message into { command, args } if it starts with a slash.
 * Returns null for plain (non-slash) messages.
 */
export function parseSlashMessage(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  if (space === -1) {
    return { command: trimmed.slice(1), args: "" };
  }
  return { command: trimmed.slice(1, space), args: trimmed.slice(space + 1).trim() };
}

export function findCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name);
}

// --- Local command actions ---

export type LocalSlashAction =
  | { kind: "clear" }
  | { kind: "new-session" }
  | { kind: "stop" }
  | { kind: "set-model"; value: string }
  | { kind: "help"; content: string };

/**
 * Execute a slash command locally if it's in the catalog. Returns null for
 * unknown commands — those are sent to the agent verbatim (the user may
 * legitimately start a message with "/" for other reasons).
 */
export function executeLocalSlashCommand(
  command: string,
  args = "",
): LocalSlashAction | null {
  const def = findCommand(command);
  if (!def?.executeLocal) return null;
  switch (command) {
    case "clear":
      return { kind: "clear" };
    case "new":
      return { kind: "new-session" };
    case "stop":
      return { kind: "stop" };
    case "model":
      return { kind: "set-model", value: args.trim() };
    case "help":
      return { kind: "help", content: renderHelp() };
    default:
      // executeLocal=true but no handler? Treat as pass-through.
      return null;
  }
}

function renderHelp(): string {
  const lines = ["**Available commands** (type `/` to open the menu):", ""];
  for (const c of SLASH_COMMANDS) {
    const args = c.args ? ` ${c.args}` : "";
    lines.push(`• \`/${c.name}${args}\` — ${c.description}`);
  }
  return lines.join("\n");
}
