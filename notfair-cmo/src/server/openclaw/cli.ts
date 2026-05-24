import { spawn } from "node:child_process";

export class OpenClawError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, stderr: string, exitCode: number | null) {
    // Surface a short snippet of stderr in the message itself — the
    // OAuth callback path only renders `error.message`, and silently
    // throwing away "what openclaw actually said" turns every CLI
    // failure into a black box. Cap at 240 chars so URL-encoded
    // redirect query strings stay reasonable.
    const snippet = stderr.trim().replace(/\s+/g, " ").slice(0, 240);
    const fullMessage = snippet ? `${message}: ${snippet}` : message;
    super(fullMessage);
    this.name = "OpenClawError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export type OpenClawOptions = {
  /** Timeout in ms. Defaults to 30s. */
  timeout?: number;
  /** When true, expect JSON on stdout and parse. Defaults to true. */
  json?: boolean;
};

/**
 * `openclaw mcp set`, `openclaw agents set` etc. all write to
 * ~/.openclaw/openclaw.json. The CLI does not lock — two concurrent
 * invocations can clobber each other's writes (provisioning fires
 * during onboarding while the OAuth callback later runs `mcp set`;
 * if they overlap, one exits non-zero with a corrupt-config message).
 *
 * Serialize every call from this process to remove the race. Calls
 * stay in-order, the queue depth is naturally bounded (we only have
 * a handful of openclaw invocations per user action), and read-only
 * commands aren't expensive enough to justify a read/write split.
 */
let openclawQueue: Promise<unknown> = Promise.resolve();

/**
 * Run an OpenClaw CLI command and return parsed stdout.
 * Always passes `--json` when `json: true` (default) — caller does not.
 */
export async function openclaw(
  args: string[],
  options: OpenClawOptions = {},
): Promise<unknown> {
  const run = () => runOpenclawWithRetry(args, options);
  const next = openclawQueue.then(run, run);
  // Keep the chain alive even when a call rejects — without `.catch`
  // a single failure would propagate forever to subsequent callers.
  openclawQueue = next.catch(() => undefined);
  return next;
}

/**
 * The OpenClaw CLI does optimistic concurrency on ~/.openclaw/openclaw.json:
 * it loads at startup, and on write checks whether the file changed
 * underneath it. When the gateway daemon (a separate process) writes
 * between our load and our write, we get exit code 1 with stderr:
 *
 *   [openclaw] Could not start the CLI.
 *   [openclaw] Reason: config changed since last load
 *
 * This is a transient cross-process race that our in-process mutex
 * can't prevent. Retry a couple of times — each attempt re-reads the
 * config, so a winning retry is essentially "no overlap this time".
 */
async function runOpenclawWithRetry(
  args: string[],
  options: OpenClawOptions,
): Promise<unknown> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runOpenclaw(args, options);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof OpenClawError)) throw err;
      const transient =
        err.exitCode === 1 &&
        /config changed since last load|EAGAIN|EBUSY/i.test(err.stderr);
      if (!transient || attempt === maxAttempts) throw err;
      // Small backoff with jitter so two competing callers don't lock-
      // step into the same retry slot forever.
      const delayMs = 150 * attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function runOpenclaw(args: string[], options: OpenClawOptions): Promise<unknown> {
  const timeout = options.timeout ?? 30_000;
  const wantJson = options.json ?? true;
  const finalArgs = wantJson && !args.includes("--json") ? [...args, "--json"] : args;

  return new Promise((resolve, reject) => {
    const proc = spawn("openclaw", finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new OpenClawError(`openclaw ${args[0] ?? ""} timed out after ${timeout}ms`, stderr, null));
    }, timeout);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new OpenClawError(
            "openclaw not found on PATH. Install: https://docs.openclaw.ai/install",
            "",
            null,
          ),
        );
        return;
      }
      reject(new OpenClawError(err.message, stderr, null));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new OpenClawError(
            `openclaw ${args.join(" ")} exited with code ${code}`,
            stderr,
            code,
          ),
        );
        return;
      }
      if (!wantJson) {
        resolve(stdout);
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (parseErr) {
        reject(
          new OpenClawError(
            `openclaw output was not valid JSON: ${(parseErr as Error).message}`,
            stderr,
            code,
          ),
        );
      }
    });
  });
}

/** Type-narrowed wrappers for common operations. */

export async function listAgents(): Promise<unknown> {
  return openclaw(["agents", "list"]);
}

export async function listCrons(): Promise<unknown> {
  return openclaw(["cron", "list"]);
}

export async function getHealth(): Promise<string> {
  return openclaw(["health"], { json: false }) as Promise<string>;
}

export async function isOpenClawAvailable(): Promise<boolean> {
  try {
    await openclaw(["--version"], { json: false, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
