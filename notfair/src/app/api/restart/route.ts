import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/restart
 *
 * Restart the server so a just-installed upgrade actually loads. How
 * depends on who supervises us (NOTFAIR_MANAGED, set by the CLI):
 *
 * - launchd: exit(0) — KeepAlive brings us straight back on the same
 *   plist, whose global-install path npm just updated in place.
 * - daemon: no supervisor, so hand off to a detached waiter process that
 *   watches for our pid to die, then starts the freshly-installed CLI on
 *   the same port and data dir.
 * - foreground/dev: refuse — killing the process under a user's terminal
 *   (or `pnpm dev`) is their call, not ours.
 */
export async function POST() {
  const managed = process.env.NOTFAIR_MANAGED ?? null;

  if (managed === "launchd") {
    scheduleExit();
    return NextResponse.json({ ok: true, note: "Restarting via launchd…" });
  }

  if (managed === "daemon") {
    const cli = await globalCliPath();
    if (!cli) {
      return NextResponse.json(
        {
          ok: false,
          error: "Could not locate the globally-installed notfair CLI.",
          hint: "Restart from your terminal: notfair stop && notfair start",
        },
        { status: 409 },
      );
    }
    const port = process.env.PORT ?? "3327";
    const dataDir = process.env.NOTFAIR_DATA_DIR ?? "";
    // The waiter must outlive us and only bind the port once we're gone.
    const waiter = `
      const [pid, cli, port, dataDir] = process.argv.slice(1);
      const deadline = Date.now() + 30000;
      const timer = setInterval(() => {
        let dead = false;
        try { process.kill(Number(pid), 0); } catch { dead = true; }
        if (!dead && Date.now() < deadline) return;
        clearInterval(timer);
        if (dead) {
          const { spawn } = require("node:child_process");
          const args = [cli, "start", "--no-open", "--port", port];
          if (dataDir) args.push("--data-dir", dataDir);
          spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
        }
        process.exit(0);
      }, 300);
    `;
    spawn(
      process.execPath,
      ["-e", waiter, String(process.pid), cli, port, dataDir],
      { cwd: homedir(), detached: true, stdio: "ignore" },
    ).unref();
    scheduleExit();
    return NextResponse.json({ ok: true, note: "Restarting…" });
  }

  return NextResponse.json(
    {
      ok: false,
      error: `Not restartable from the app (mode: ${managed ?? "unknown"}).`,
      hint: "Restart NotFair from the terminal that runs it.",
    },
    { status: 409 },
  );
}

function scheduleExit() {
  // Let the response flush before dying.
  setTimeout(() => process.exit(0), 500).unref();
}

async function globalCliPath(): Promise<string | null> {
  const root = await new Promise<string | null>((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("npm", ["root", "-g"], {
        cwd: homedir(),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    setTimeout(() => resolve(null), 10_000).unref();
  });
  if (!root) return null;
  const cli = join(root, "notfair", "bin", "cli.mjs");
  return existsSync(cli) ? cli : null;
}
