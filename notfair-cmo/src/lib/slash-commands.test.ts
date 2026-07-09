import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  executeLocalSlashCommand,
  filterSlashCommands,
  findCommand,
  parseSlashMessage,
} from "./slash-commands";

describe("SLASH_COMMANDS catalog", () => {
  it("has unique command keys", () => {
    const keys = SLASH_COMMANDS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has unique command names", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks every command as executeLocal — no dead OpenClaw passthroughs", () => {
    // The catalog used to carry ~17 OpenClaw gateway directives
    // (/compact, /status, /elevated, …) that were sent to the agent as
    // literal text. notfair-cmo has no gateway; only commands the client
    // itself handles belong here.
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.executeLocal).toBe(true);
    }
    for (const name of ["clear", "new", "stop", "model", "help"]) {
      expect(findCommand(name)).toBeDefined();
    }
    for (const gone of ["status", "compact", "think", "elevated", "skill", "queue"]) {
      expect(findCommand(gone)).toBeUndefined();
    }
  });
});

describe("filterSlashCommands", () => {
  it("returns all commands for empty query", () => {
    expect(filterSlashCommands("")).toEqual(SLASH_COMMANDS);
    expect(filterSlashCommands("   ")).toEqual(SLASH_COMMANDS);
  });

  it("returns all commands for a bare slash", () => {
    expect(filterSlashCommands("/")).toEqual(SLASH_COMMANDS);
  });

  it("prefix-matches with or without leading slash", () => {
    const a = filterSlashCommands("cl");
    const b = filterSlashCommands("/cl");
    expect(a).toEqual(b);
    expect(a.some((c) => c.name === "clear")).toBe(true);
  });

  it("is case-insensitive", () => {
    const lower = filterSlashCommands("CL");
    expect(lower.some((c) => c.name === "clear")).toBe(true);
  });

  it("falls back to substring match when no prefix hits", () => {
    // "od" does not prefix any command name, but `model` contains it,
    // so the substring fallback should surface it.
    const r = filterSlashCommands("od");
    const names = r.map((c) => c.name);
    expect(names).toContain("model");
    expect(names.every((n) => n.toLowerCase().startsWith("od"))).toBe(false);
  });

  it("returns empty list when nothing matches", () => {
    expect(filterSlashCommands("zzzzzz")).toEqual([]);
  });

  it("prefers prefix matches over substring matches", () => {
    // "cl" prefix-matches `clear`. It should NOT fall back to substring,
    // and the result must contain only prefix hits.
    const r = filterSlashCommands("cl");
    expect(r.every((c) => c.name.toLowerCase().startsWith("cl"))).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe("parseSlashMessage", () => {
  it("returns null for plain text", () => {
    expect(parseSlashMessage("hello")).toBeNull();
    expect(parseSlashMessage("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(parseSlashMessage("   ")).toBeNull();
  });

  it("parses a bare slash command", () => {
    expect(parseSlashMessage("/clear")).toEqual({ command: "clear", args: "" });
  });

  it("parses a slash command with args", () => {
    expect(parseSlashMessage("/model gpt-5.5 codex")).toEqual({
      command: "model",
      args: "gpt-5.5 codex",
    });
  });

  it("trims trailing whitespace from args", () => {
    expect(parseSlashMessage("/model gpt-5   ")).toEqual({
      command: "model",
      args: "gpt-5",
    });
  });

  it("trims leading whitespace from the message", () => {
    expect(parseSlashMessage("   /help")).toEqual({ command: "help", args: "" });
  });

  it("treats a lone slash as an empty command", () => {
    expect(parseSlashMessage("/")).toEqual({ command: "", args: "" });
  });
});

describe("findCommand", () => {
  it("finds a known command by name", () => {
    const cmd = findCommand("model");
    expect(cmd).toBeDefined();
    expect(cmd?.key).toBe("model");
  });

  it("returns undefined for an unknown command", () => {
    expect(findCommand("nope")).toBeUndefined();
  });

  it("is case-sensitive on the canonical name", () => {
    expect(findCommand("CLEAR")).toBeUndefined();
  });
});

describe("executeLocalSlashCommand", () => {
  it("returns a clear action for /clear", () => {
    expect(executeLocalSlashCommand("clear")).toEqual({ kind: "clear" });
  });

  it("returns a new-session action for /new", () => {
    expect(executeLocalSlashCommand("new")).toEqual({ kind: "new-session" });
  });

  it("returns a stop action for /stop", () => {
    expect(executeLocalSlashCommand("stop")).toEqual({ kind: "stop" });
  });

  it("returns a set-model action for /model, carrying the argument", () => {
    expect(executeLocalSlashCommand("model", "gpt-5.5")).toEqual({
      kind: "set-model",
      value: "gpt-5.5",
    });
    // No argument → empty value; the composer shows current + options.
    expect(executeLocalSlashCommand("model")).toEqual({
      kind: "set-model",
      value: "",
    });
  });

  it("returns a help action with rendered markdown content", () => {
    const r = executeLocalSlashCommand("help");
    expect(r?.kind).toBe("help");
    if (r?.kind !== "help") return;
    expect(r.content).toContain("Available commands");
    expect(r.content).toContain("/clear");
    // Commands that declare args render them.
    expect(r.content).toContain("/model <model>");
  });

  it("returns null for removed OpenClaw passthrough commands", () => {
    expect(executeLocalSlashCommand("status")).toBeNull();
    expect(executeLocalSlashCommand("compact")).toBeNull();
  });

  it("returns null for an unknown command", () => {
    expect(executeLocalSlashCommand("nope")).toBeNull();
  });
});
