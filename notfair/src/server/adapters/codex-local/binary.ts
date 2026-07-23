import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ResolveCodexBinaryOptions = {
  env?: {
    PATH?: string;
    NOTFAIR_CODEX_BIN?: string;
  };
  homeDir?: string;
  platform?: NodeJS.Platform;
  isExecutable?: (candidate: string) => boolean;
};

function canExecute(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve Codex without assuming the server inherited an interactive shell's
 * PATH. macOS background services commonly miss app-bundled executables even
 * though Codex is available through the ChatGPT desktop app.
 */
export function resolveCodexBinary(
  options: ResolveCodexBinaryOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env.NOTFAIR_CODEX_BIN?.trim();
  if (explicit) return explicit;

  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const pathSeparator = platform === "win32" ? ";" : ":";
  const candidates = (env.PATH ?? "")
    .split(pathSeparator)
    .filter(Boolean)
    .map((directory) => join(directory, executableName));

  if (platform === "darwin") {
    candidates.push(
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      join(homeDir, "Applications/ChatGPT.app/Contents/Resources/codex"),
      "/Applications/Codex.app/Contents/Resources/codex",
      join(homeDir, "Applications/Codex.app/Contents/Resources/codex"),
    );
  }

  if (platform !== "win32") {
    candidates.push(
      join(homeDir, ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    );
  }

  const isExecutable = options.isExecutable ?? canExecute;
  return [...new Set(candidates)].find(isExecutable) ?? "codex";
}
