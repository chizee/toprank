import {
  Edit3,
  FileText,
  Globe,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * Tool-name humanization for the chat surface. Pure functions only —
 * everything here maps raw harness tool identifiers and command lines to
 * the short human phrases the transcript shows.
 */

/**
 * Minimum catalog shape the chat needs to render an MCP server's brand icon
 * next to its tool calls. Mirrors `McpSpec` from `mcp-catalog.ts` — we
 * accept the broader type but only use these fields here.
 */
export type McpCatalogEntryLite = {
  key: string;
  display_name: string;
  resource_url: string;
};

export type ToolIntent = { verb: string; target?: string };

/**
 * Strip the project-slug prefix and the namespace path so the user sees
 * the bare action name. Tools come in two conventions:
 *   `<mcp>.action`             → e.g. `notfair.runScript`
 *   `<project>-<mcp>__action`  → e.g. `demo1-notfair-googleads__runScript`
 * Both should render as just the action. Falls back to the input untouched.
 */
export function formatToolName(name: string): string {
  if (!name) return name;
  // Codex names can nest both separators (`notfair_<slug>__notfair_goals.propose_target`)
  // — strip namespaces for BOTH, keeping only the action.
  let out = name;
  for (const sep of ["__", "."]) {
    const idx = out.lastIndexOf(sep);
    if (idx >= 0) {
      const tail = out.slice(idx + sep.length);
      if (tail) out = tail;
    }
  }
  return out;
}

/**
 * Human-readable intent for a tool call, used wherever we'd otherwise
 * surface a raw command line or namespaced tool identifier in the chat.
 *
 * Two layers:
 *   1. Shell-flavored names (`shell`, `bash`, `exec`, Claude's `Bash`):
 *      unwrap the standard `bash -lc "..."` wrapper, look at the leading
 *      binary, map common ones to verb phrases (`rg` → "Searched files",
 *      `git status` → "Ran git status", …). Falls back to `Ran <bin>`.
 *   2. Built-in coding tools (Read, Write, Edit, fetch, …) and MCP tool
 *      names (`runScript`, `mcp__notfair__listAdAccounts`, …) get a
 *      tailored verb based on the tool name, with the label surfaced as
 *      the target detail (file path, URL, or short label string).
 *
 * The returned `verb` is what the collapsed tool group shows; `target`
 * is the optional second-half detail truncated by the row's CSS. The
 * raw command/label still lives in the expanded body so power users can
 * see exactly what ran.
 */
export function humanizeTool(name: string, label: string | null): ToolIntent {
  const n = (name ?? "").toLowerCase();
  // Shell / exec — Codex (`shell`) and Claude Code (`Bash` / `bash` / `exec`).
  // Also catches the legacy transcript rows the v0.4.2 parser left behind:
  // old codex `command_execution` items stored the raw command's first
  // line as BOTH name and label, so we sniff the name/label for the
  // characteristic shell wrapper (`bash -lc "…"`, leading `/bin/zsh`,
  // etc.) and route them through the shell humanizer too.
  if (
    n === "shell" ||
    n === "bash" ||
    n === "exec" ||
    looksLikeShellInvocation(name) ||
    looksLikeShellInvocation(label ?? "")
  ) {
    // Prefer the label when present (newer events store the command
    // there); fall back to the name for pre-fix rows where the command
    // was written into the name field.
    const cmdSource = label && label.trim().length > 0 ? label : name ?? "";
    return humanizeShellCommand(cmdSource);
  }
  // File reads.
  if (n === "read" || n === "cat" || n === "open") {
    return { verb: "Read file", target: label ? shortenPathish(label) : undefined };
  }
  // File writes / edits.
  if (n === "write")
    return { verb: "Wrote file", target: label ? shortenPathish(label) : undefined };
  if (n === "edit" || n === "patch")
    return { verb: "Edited file", target: label ? shortenPathish(label) : undefined };
  // Web.
  if (n === "fetch" || n === "webfetch" || n.includes("http"))
    return { verb: "Fetched URL", target: label ?? undefined };
  if (n === "websearch" || n === "search" || n === "google")
    return { verb: "Searched the web", target: label ?? undefined };
  // MCP / generic tool — strip namespace prefixes and speak the action
  // in natural language ("Listed ad accounts", "Ran a query", …).
  return mcpActionIntent(formatToolName(name), label, name);
}

/**
 * Natural-language intent for an MCP/generic action name. The convention
 * across the catalog is verb-first camelCase (`listAdAccounts`,
 * `updateCampaignBudget`, `exec`), so the leading token picks the verb
 * phrase and the rest names the object. Unknown verbs fall back to
 * "Called <action>" — honest, never wrong.
 */
function mcpActionIntent(
  action: string,
  label: string | null,
  fullName = "",
): ToolIntent {
  const pretty = prettifyToolAction(action); // e.g. "list ad accounts"
  const [head = "", ...rest] = pretty.split(" ");
  const obj = rest.join(" ");
  const target = label ?? undefined;
  // SQL-looking labels beat name heuristics: whatever the tool is called,
  // the user is looking at a query. Analytics servers whose exec IS a
  // query engine (PostHog) qualify by name even for label-less legacy
  // rows — their exec has no other meaning.
  const sqlish =
    (!!label &&
      /^\s*(select|with|insert|delete\s+from|update\s+\w+\s+set)\b/i.test(label)) ||
    fullName.toLowerCase().includes("posthog");
  switch (head.toLowerCase()) {
    case "exec":
    case "execute":
    case "query":
    case "hogql":
      return { verb: sqlish ? "Ran a query" : "Ran a command", target };
    case "run":
      return { verb: obj ? `Ran ${obj}` : sqlish ? "Ran a query" : "Ran a task", target };
    case "list":
      return { verb: obj ? `Listed ${obj}` : "Listed records", target };
    case "get":
    case "fetch":
    case "read":
      return { verb: obj ? `Fetched ${obj}` : "Fetched data", target };
    case "search":
      return { verb: obj ? `Searched ${obj}` : "Searched", target };
    case "create":
    case "add":
      return { verb: obj ? `Created ${obj}` : "Created a record", target };
    case "update":
    case "set":
    case "amend":
      return { verb: obj ? `Updated ${obj}` : "Updated a record", target };
    case "delete":
    case "remove":
      return { verb: obj ? `Removed ${obj}` : "Removed a record", target };
    case "enable":
      return { verb: `Enabled ${obj || "a resource"}`, target };
    case "pause":
      return { verb: `Paused ${obj || "a resource"}`, target };
    case "resume":
      return { verb: `Resumed ${obj || "a resource"}`, target };
    case "rename":
      return { verb: `Renamed ${obj || "a resource"}`, target };
    case "propose":
      return { verb: `Proposed ${obj || "a change"}`, target };
    case "log":
      return { verb: `Logged ${obj || "a record"}`, target };
    case "review":
      return { verb: `Reviewed ${obj || "a record"}`, target };
    case "register":
      return { verb: `Registered ${obj || "a record"}`, target };
    case "backfill":
      return { verb: `Backfilled ${obj || "history"}`, target };
    case "verify":
      return { verb: `Verified ${obj || "a definition"}`, target };
    case "upload":
      return { verb: `Uploaded ${obj || "data"}`, target };
    case "send":
      return { verb: `Sent ${obj || "a message"}`, target };
    default:
      return { verb: `Called ${pretty}`, target };
  }
}

const SHELL_WRAPPER_RE =
  /^(?:[/\w.-]+\/)?(?:zsh|bash|sh|dash|ksh)\s+(?:-[A-Za-z]*c|-c)\s+(['"])([\s\S]*)\1\s*$/;

/**
 * Heuristic for "this string is a shell command, not a tool identifier."
 * Used to rescue transcript rows from before v0.4.3, where the codex
 * parser stored the raw command's first line as the tool `name`. Those
 * rows were rendering with the catch-all "Called …" verb, often
 * truncated to garbage like `Called md"` after `formatToolName` split
 * on the trailing `.md"`. Conservative — only matches recognizable
 * shell prefixes, command separators in non-trivial strings, or
 * leading `/usr/bin`-style binary paths. Returns false on empty / short
 * tokens so real MCP tool names like `runScript` don't get misrouted.
 */
export function looksLikeShellInvocation(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 3) return false;
  // Standard `bash -lc "..."`-style wrappers.
  if (/^(?:[/\w.-]+\/)?(?:zsh|bash|sh|dash|ksh)\s+(?:-[A-Za-z]*c|-c)\b/.test(t))
    return true;
  // Leading absolute binary path (e.g. `/usr/bin/find`, `/bin/ls`).
  if (/^\/(?:usr\/|bin\/|opt\/|sbin\/)/.test(t)) return true;
  // Contains shell metacharacters in a way that's incompatible with any
  // sane tool identifier — pipes, redirects, quoted args, command
  // chains. Combined with a length guard above this skips short
  // identifiers but catches multi-token command lines.
  if (/\s\|\s|\s&&\s|\s>>?\s|^["']|["']\s|\s["']/.test(t)) return true;
  return false;
}

function unwrapShellWrapper(cmd: string): string {
  const m = cmd.trim().match(SHELL_WRAPPER_RE);
  if (m) return m[2]!.trim();
  return cmd.trim();
}

export function humanizeShellCommand(rawCmd: string): ToolIntent {
  const inner = unwrapShellWrapper(rawCmd);
  if (!inner) return { verb: "Ran shell command" };
  // Take the leading effective command (before pipes / && / ;). Stops short
  // of full shell parsing — good enough for the leading-verb mapping.
  const lead = inner.split(/\s*(?:[|&;]|\|\|)\s*/)[0]!.trim();
  const tokens = lead.split(/\s+/);
  const head = (tokens[0] ?? "").toLowerCase();
  const sub = tokens[1] ?? "";
  const firstLine = inner.split("\n")[0]!;
  const targetForExpand =
    firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  switch (head) {
    case "pwd":
      return { verb: "Checked working directory" };
    case "ls":
      return { verb: "Listed files", target: extractPathArg(tokens) };
    case "find":
      return { verb: "Searched the filesystem", target: extractPathArg(tokens) };
    case "rg":
    case "grep":
    case "ag":
    case "ack":
      return {
        verb: "Searched files",
        target: extractQuotedToken(inner) ?? extractPathArg(tokens),
      };
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "bat":
      return { verb: "Read file", target: extractPathArg(tokens) };
    case "git": {
      if (!sub) return { verb: "Ran git", target: targetForExpand };
      return { verb: `Ran git ${sub}` };
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      if (sub === "test" || sub === "t") return { verb: "Ran tests" };
      if (sub === "install" || sub === "add" || sub === "i")
        return { verb: "Installed packages" };
      if (sub === "run") {
        const script = tokens[2];
        return { verb: script ? `Ran ${head} ${script}` : `Ran ${head}` };
      }
      return { verb: sub ? `Ran ${head} ${sub}` : `Ran ${head}` };
    }
    case "node":
    case "python":
    case "python3":
    case "tsx":
    case "deno":
    case "ts-node":
      return { verb: "Ran script", target: extractPathArg(tokens) };
    case "curl":
    case "wget":
    case "http":
      return { verb: "Fetched URL", target: extractUrl(inner) };
    case "mkdir":
      return { verb: "Created directory", target: extractPathArg(tokens) };
    case "touch":
      return { verb: "Created file", target: extractPathArg(tokens) };
    case "rm":
      return { verb: "Removed file(s)", target: extractPathArg(tokens) };
    case "mv":
      return { verb: "Moved file" };
    case "cp":
      return { verb: "Copied file" };
    case "sed":
    case "awk":
      return { verb: "Edited text", target: extractPathArg(tokens) };
    case "which":
    case "type":
    case "whereis":
      return { verb: "Located binary", target: tokens[1] };
    case "echo":
    case "printf":
      return { verb: "Printed text" };
    case "make":
      return { verb: sub ? `Ran make ${sub}` : "Ran make" };
    case "docker":
      return { verb: sub ? `Ran docker ${sub}` : "Ran docker" };
    case "kubectl":
      return { verb: sub ? `Ran kubectl ${sub}` : "Ran kubectl" };
    case "gh":
      return { verb: sub ? `Ran gh ${sub}` : "Ran gh" };
    case "":
      return { verb: "Ran shell command" };
    default:
      return { verb: `Ran ${head}`, target: targetForExpand };
  }
}

function extractPathArg(tokens: string[]): string | undefined {
  // Last token that isn't a flag and isn't the leading binary.
  for (let i = tokens.length - 1; i >= 1; i--) {
    const t = tokens[i]!;
    if (!t.startsWith("-") && !/^[<>|&]+$/.test(t)) {
      return shortenPathish(t.replace(/^['"]|['"]$/g, ""));
    }
  }
  return undefined;
}

function extractUrl(inner: string): string | undefined {
  const m = inner.match(/https?:\/\/[^\s'"]+/);
  return m?.[0];
}

function extractQuotedToken(inner: string): string | undefined {
  const m = inner.match(/['"]([^'"\n]{1,80})['"]/);
  if (!m) return undefined;
  return `"${m[1]}"`;
}

export function shortenPathish(p: string): string {
  if (!p) return p;
  // Don't compress URLs.
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  const segs = p.split("/").filter(Boolean);
  if (segs.length <= 2) return p;
  return `…/${segs.slice(-2).join("/")}`;
}

/**
 * Map a tool action like `listAdAccounts` to a human-readable phrase
 * (`list ad accounts`). Splits on camelCase and snake_case boundaries
 * and lowercases — leaves single-word actions like `runScript` alone
 * after the split. Returns the action unchanged when there's nothing
 * to split.
 */
function prettifyToolAction(action: string): string {
  if (!action) return action;
  const withSpaces = action
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!withSpaces) return action;
  // Don't lowercase one-token names so single identifiers like "runScript"
  // (already split to "run Script") read naturally as "run Script"; we
  // only lowercase the tail to keep proper capitalization of the leading
  // verb the model chose.
  return withSpaces.charAt(0).toLowerCase() + withSpaces.slice(1).toLowerCase();
}

/**
 * Walk the MCP catalog looking for a server key that matches the tool
 * name's namespace prefix. The two harnesses use different schemes:
 *
 *   - **Claude Code**: `mcp__<serverKey>__<tool>`  (e.g. `mcp__NotFair-GoogleAds__createCampaign`)
 *   - **Codex**:       `notfair_<projectSlug>__<serverNameUnderscored>__<tool>`
 *
 * We match by normalizing both sides to lowercase + collapsing `-` and
 * `_` so `NotFair-GoogleAds`, `notfair_googleads`, and `notfair-googleads`
 * all collide on the same catalog entry. Returns null when the tool
 * name doesn't carry a recognizable MCP prefix or the prefix isn't in
 * the catalog (e.g. an unprovisioned server, or a non-MCP built-in).
 */
export function matchMcpServerKey(
  toolName: string,
  catalog: McpCatalogEntryLite[] | undefined,
): McpCatalogEntryLite | null {
  if (!toolName || !catalog || catalog.length === 0) return null;
  const candidates: string[] = [];
  // Claude Code: mcp__<serverKey>__<tool>
  const claude = toolName.match(/^mcp__([^_].*?)__/);
  if (claude?.[1]) candidates.push(claude[1]);
  // Codex MCP, namespaced + tool suffix:
  //   notfair_<projectSlug>__<serverNameUnderscored>__<tool>
  const codexUnderscored = toolName.match(
    /^notfair_[A-Za-z0-9_]+?__([A-Za-z0-9_]+?)__/,
  );
  if (codexUnderscored?.[1]) candidates.push(codexUnderscored[1]);
  // Codex MCP via the `<server>.<tool>` shape this parser uses for
  // `mcp_tool_call` items. The server is the FULL namespaced config key
  // (e.g. `notfair_demo__notfair_googleads`), so peel the leading
  // `notfair_<projectSlug>__` prefix off too — the catalog stores the
  // bare server key.
  const dot = toolName.match(/^([A-Za-z0-9_-]+)\./);
  if (dot?.[1]) {
    candidates.push(dot[1]);
    const tail = dot[1].match(/^notfair_[A-Za-z0-9_]+?__(.+)$/);
    if (tail?.[1]) candidates.push(tail[1]);
  }
  if (candidates.length === 0) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  for (const cand of candidates) {
    const target = norm(cand);
    const hit = catalog.find((c) => norm(c.key) === target);
    if (hit) return hit;
  }
  return null;
}

export function iconForTool(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n === "exec" || n === "shell" || n === "bash" || n.includes("bash"))
    return Terminal;
  if (n === "read" || n === "cat" || n === "open" || n.includes("read"))
    return FileText;
  if (n === "write" || n === "edit" || n === "patch") return Edit3;
  if (n === "fetch" || n.includes("http") || n.includes("web")) return Globe;
  return Wrench;
}
