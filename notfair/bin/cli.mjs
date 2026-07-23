#!/usr/bin/env node
// NotFair CLI entry point.
// Compiled-free: stays as plain ESM JS so it works straight from npm without a build step
// for the CLI surface. The Next.js app itself is built and shipped under .next/standalone.
//
// Process model: `notfair start` runs the server as a detached background
// process (state in <data-dir>/server.json, log in <data-dir>/logs/server.log);
// `--foreground` stays attached and is what launchd runs. When autostart is
// enabled, launchd is the single owner — start/stop delegate to launchctl so
// KeepAlive never fights the CLI over the same port.

import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { Command } from "commander";
import open from "open";

import {
  resolveCompatibleNodeRuntime,
  syncStandaloneNativeBindings,
} from "./native-bindings.mjs";

const CLI_PATH = fileURLToPath(import.meta.url);
const __dirname = dirname(CLI_PATH);
const PKG_ROOT = dirname(__dirname);
// Resolved to absolute: the value is forwarded as NOTFAIR_DATA_DIR to the
// standalone server, whose cwd is the package dir — a relative path would
// silently land the database inside the npm/npx cache.
const DATA_DIR = resolve(process.env.NOTFAIR_DATA_DIR ?? join(homedir(), ".notfair"));
const LAUNCHD_LABEL = "co.notfair.server";

const program = new Command();
program
  .name("notfair")
  .description("Goal-driven, loop-powered marketing agents that crush your business goals 24/7 — on top of Claude Code or Codex.")
  .version(readPackageVersion());

program
  .command("start", { isDefault: true })
  .description("Start NotFair in the background and open the UI in your browser.")
  .option("-p, --port <port>", "Port to bind", "3327")
  .option("--no-open", "Do not auto-open the browser")
  .option("--foreground", "Stay attached to this terminal instead of running in the background")
  .option("--data-dir <dir>", "Override data directory", (dir) => resolve(dir), DATA_DIR)
  .action(async (opts) => {
    ensureDataDir(opts.dataDir);

    const standalonePath = join(PKG_ROOT, ".next", "standalone", "server.js");
    if (!existsSync(standalonePath)) {
      console.error("Build artifacts not found. This usually means you're running");
      console.error("from source without a build. Run: pnpm build");
      console.error(`Expected: ${standalonePath}`);
      process.exit(2);
    }

    // When autostart owns the server, starting it by hand would race launchd
    // onto the same port — delegate to launchctl instead.
    if (!opts.foreground && process.platform === "darwin" && existsSync(plistPath())) {
      await startViaLaunchd(opts);
      return;
    }

    if (!opts.foreground) {
      const running = getState(opts.dataDir);
      if (running && (await isHealthy(running.url))) {
        console.log(`NotFair is already running on ${running.url} (pid ${running.pid}).`);
        if (opts.open !== false) await open(running.url).catch(() => {});
        return;
      }
      if (running) {
        console.log(
          `A NotFair process (pid ${running.pid}) exists but isn't answering on ${running.url} yet.`,
        );
        console.log("Check `notfair status` / `notfair logs`, or `notfair stop` and retry.");
        process.exit(1);
      }
    }

    const desired = Number.parseInt(opts.port, 10);
    const port = await findFreePort(desired);
    if (port !== desired) {
      console.log(`Port ${desired} was busy, using ${port} instead.`);
    }

    // Next.js standalone output omits .next/static and public by default; copy
    // them in if they're missing so the server can serve CSS/JS chunks.
    ensureStandaloneAssets();
    const serverNode = resolveCompatibleNodeRuntime(PKG_ROOT);
    syncStandaloneNativeBindings(PKG_ROOT);

    const url = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NOTFAIR_DATA_DIR: opts.dataDir,
      // Tells the server who supervises it, so /api/restart knows whether
      // an in-app "Restart now" is safe (launchd flows through untouched).
      NOTFAIR_MANAGED: opts.foreground
        ? process.env.NOTFAIR_MANAGED ?? "foreground"
        : "daemon",
    };

    if (opts.foreground) {
      const child = spawn(serverNode, [standalonePath], { stdio: "inherit", env });
      writeState(opts.dataDir, {
        pid: child.pid,
        port,
        url,
        data_dir: opts.dataDir,
        version: readPackageVersion(),
        started_at: new Date().toISOString(),
        managed: process.env.NOTFAIR_MANAGED ?? "foreground",
      });

      console.log(`NotFair running on ${url}`);

      if (opts.open !== false) {
        setTimeout(() => {
          open(url).catch(() => {
            console.log(`Open ${url} in your browser.`);
          });
        }, 800);
      }

      const shutdown = () => {
        child.kill("SIGTERM");
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      child.on("close", (code) => {
        clearState(opts.dataDir);
        process.exit(code ?? 0);
      });
      return;
    }

    // Background mode: detach, log to a file, and only report success once
    // the server actually answers HTTP.
    mkdirSync(dirname(logFile(opts.dataDir)), { recursive: true });
    const fd = openSync(logFile(opts.dataDir), "a");
    const child = spawn(serverNode, [standalonePath], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.unref();
    closeSync(fd);
    writeState(opts.dataDir, {
      pid: child.pid,
      port,
      url,
      data_dir: opts.dataDir,
      version: readPackageVersion(),
      started_at: new Date().toISOString(),
      managed: "daemon",
    });

    const healthy = await waitFor(() => isHealthy(url), 30_000, 500);
    if (!healthy) {
      console.error(`NotFair did not answer on ${url} within 30s. Last log lines:`);
      printLogTail(opts.dataDir, 20);
      console.error(`Full log: ${logFile(opts.dataDir)}`);
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
      clearState(opts.dataDir);
      process.exit(1);
    }

    console.log(`NotFair running in the background on ${url} (pid ${child.pid}).`);
    console.log("  notfair status     check health");
    console.log("  notfair logs -f    follow the server log");
    console.log("  notfair stop       stop the background server");
    if (process.platform === "darwin" && !existsSync(plistPath())) {
      console.log("  notfair autostart enable   start automatically at login");
    }
    if (opts.open !== false) {
      await open(url).catch(() => {
        console.log(`Open ${url} in your browser.`);
      });
    }
  });

program
  .command("stop")
  .description("Stop the background NotFair server.")
  .option("--data-dir <dir>", "Override data directory", (dir) => resolve(dir), DATA_DIR)
  .action(async (opts) => {
    // launchd-managed: stop through launchctl, or KeepAlive resurrects the
    // process the moment we kill it.
    if (process.platform === "darwin" && (await launchAgentLoaded())) {
      await runCheck("launchctl", ["bootout", launchdServiceTarget()]);
      const state = getState(opts.dataDir);
      if (state) {
        await waitFor(() => !isPidAlive(state.pid), 10_000);
        clearState(opts.dataDir);
      }
      console.log("Stopped NotFair (launchd-managed).");
      if (existsSync(plistPath())) {
        console.log(
          "Autostart stays enabled — it starts again at your next login. `notfair autostart disable` turns that off.",
        );
      }
      return;
    }

    const state = getState(opts.dataDir);
    if (!state || !isPidAlive(state.pid)) {
      clearState(opts.dataDir);
      console.log("NotFair is not running.");
      return;
    }
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {}
    let dead = await waitFor(() => !isPidAlive(state.pid), 10_000);
    if (!dead) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {}
      dead = await waitFor(() => !isPidAlive(state.pid), 3_000);
    }
    clearState(opts.dataDir);
    if (!dead) {
      console.error(`Could not stop pid ${state.pid} — kill it manually.`);
      process.exit(1);
    }
    console.log(`Stopped NotFair (pid ${state.pid}).`);
  });

program
  .command("status")
  .description("Show whether NotFair is running, where, and its autostart state.")
  .option("--data-dir <dir>", "Override data directory", (dir) => resolve(dir), DATA_DIR)
  .action(async (opts) => {
    const state = getState(opts.dataDir);
    const alive = state ? isPidAlive(state.pid) : false;
    const healthy = alive ? await isHealthy(state.url) : false;

    if (!alive) {
      if (state) clearState(opts.dataDir);
      console.log("NotFair is not running.");
    } else {
      console.log(
        healthy
          ? "NotFair is running."
          : "NotFair process is alive but not answering HTTP (starting up, or wedged — see logs).",
      );
      console.log(`  url      ${state.url}`);
      console.log(`  pid      ${state.pid}`);
      console.log(`  version  ${state.version ?? "unknown"}`);
      console.log(`  mode     ${state.managed ?? "unknown"}`);
      console.log(`  started  ${state.started_at ?? "unknown"}${formatUptime(state.started_at)}`);
      console.log(`  log      ${logFile(opts.dataDir)}`);
    }

    if (process.platform === "darwin") {
      const enabled = existsSync(plistPath());
      const loaded = enabled && (await launchAgentLoaded());
      console.log(
        `  autostart  ${enabled ? (loaded ? "enabled (loaded)" : "enabled (loads at next login)") : "disabled"}`,
      );
    }

    process.exit(alive && healthy ? 0 : 1);
  });

program
  .command("logs")
  .description("Show the background server's log.")
  .option("-n, --lines <n>", "Number of trailing lines to print", "100")
  .option("-f, --follow", "Keep following the log (like tail -f)")
  .option("--data-dir <dir>", "Override data directory", (dir) => resolve(dir), DATA_DIR)
  .action((opts) => {
    const file = logFile(opts.dataDir);
    if (!existsSync(file)) {
      console.log(`No log yet at ${file} — has the server been started in the background?`);
      return;
    }
    const lines = Number.parseInt(opts.lines, 10) || 100;
    if (opts.follow) {
      const tail = spawn("tail", ["-n", String(lines), "-F", file], { stdio: "inherit" });
      tail.on("close", (code) => process.exit(code ?? 0));
      return;
    }
    printLogTail(opts.dataDir, lines);
  });

program
  .command("doctor")
  .description("Verify this machine is ready to run NotFair.")
  .option("--data-dir <dir>", "Override data directory", (dir) => resolve(dir), DATA_DIR)
  .option("-p, --port <port>", "Preferred port for the server", "3327")
  .action(async (opts) => {
    const results = [];

    const node = checkNodeVersion();
    results.push(node);

    // Probe each supported harness adapter. NotFair can run on any of
    // them, so doctor lists status for all; at least one needs to be ok.
    const claude = node.ok
      ? await checkHarnessInstalled("Claude Code", "claude")
      : skipped("Claude Code installed", "node version too old");
    results.push(claude);

    const codex = node.ok
      ? await checkHarnessInstalled("Codex", "codex")
      : skipped("Codex installed", "node version too old");
    results.push(codex);

    if (!claude.ok && !codex.ok) {
      results.push(
        fail(
          "Harness available",
          "neither Claude Code nor Codex is on PATH",
          "Install at least one: https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview or https://github.com/openai/codex",
        ),
      );
    } else {
      const ready = [claude.ok ? "Claude Code" : null, codex.ok ? "Codex" : null].filter(Boolean);
      results.push(pass("Harness available", ready.join(", ")));
    }

    const dataDir = checkDataDir(opts.dataDir);
    results.push(dataDir);

    const port = await checkPortAvailable(Number.parseInt(opts.port, 10));
    results.push(port);

    printResults(results);

    const failed = results.filter((r) => r.status === "fail").length;
    process.exit(failed === 0 ? 0 : 1);
  });

program
  .command("update")
  .description("Update NotFair to the latest npm version and restart the running server.")
  .option("--data-dir <dir>", "Override data directory", (dir) => resolve(dir), DATA_DIR)
  .action(async (opts) => {
    const current = readPackageVersion();
    const latest = await fetchLatestVersion();
    if (!latest) {
      console.error("Could not reach the npm registry — are you online?");
      process.exit(1);
    }
    if (!isVersionNewer(latest, current)) {
      console.log(`Already on the latest version (v${current}).`);
      return;
    }
    console.log(`Update available: v${current} → v${latest}`);

    // A source checkout can't be updated by npm — don't pave over it.
    if (existsSync(join(PKG_ROOT, "src")) && existsSync(join(PKG_ROOT, "next.config.ts"))) {
      console.log("You're running from source. Update with: git pull && pnpm install && pnpm build");
      process.exit(1);
    }

    console.log(`Installing notfair@${latest} globally…`);
    const installed = await runInherit("npm", ["install", "-g", `notfair@${latest}`]);
    if (!installed) {
      console.error("npm install failed. Try it directly: npm install -g notfair@latest");
      process.exit(1);
    }
    const newCli = await globalCliPath();
    if (PKG_ROOT.includes(`${sep}_npx${sep}`) && newCli) {
      console.log("Installed globally — run future commands as plain `notfair`.");
    }

    // Restart whatever is running so the new version actually loads.
    if (process.platform === "darwin" && existsSync(plistPath())) {
      const cfg = readPlistConfig();
      const port = cfg?.port ?? 3327;
      if (newCli) {
        writeFileSync(plistPath(), renderPlist(port, cfg?.dataDir ?? DATA_DIR, newCli));
      }
      await reloadLaunchAgent();
      const url = `http://127.0.0.1:${port}`;
      const healthy = await waitFor(() => isHealthy(url), 30_000, 500);
      console.log(
        healthy
          ? `Updated to v${latest} — NotFair restarted on ${url}.`
          : `Updated to v${latest}, but the restart hasn't answered yet — check \`notfair status\`.`,
      );
      return;
    }

    const state = getState(opts.dataDir);
    if (state && isPidAlive(state.pid)) {
      if (!newCli) {
        console.log(`Updated to v${latest}. Restart to apply: notfair stop && notfair start`);
        return;
      }
      console.log("Restarting the background server…");
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      await waitFor(() => !isPidAlive(state.pid), 10_000);
      clearState(opts.dataDir);
      const args = [newCli, "start", "--no-open", "--port", String(state.port), "--data-dir", state.data_dir ?? opts.dataDir];
      const ok = await runInherit(process.execPath, args);
      process.exit(ok ? 0 : 1);
    }

    console.log(`Updated to v${latest}. Start it with: notfair start`);
  });

const autostart = program
  .command("autostart")
  .description("Start NotFair automatically at login (macOS launchd).");

autostart
  .command("enable")
  .description("Install a launchd LaunchAgent: starts at login, restarts on crash.")
  .option("-p, --port <port>", "Port the login server binds", "3327")
  .option("--data-dir <dir>", "Override data directory", (dir) => resolve(dir), DATA_DIR)
  .action(async (opts) => {
    requireDarwin();
    if (PKG_ROOT.includes(`${sep}_npx${sep}`)) {
      console.log("Warning: you're running from the npx cache, which npm may clear at any time.");
      console.log("For a reliable autostart, install globally first: npm install -g notfair");
    }
    ensureDataDir(opts.dataDir);
    mkdirSync(dirname(logFile(opts.dataDir)), { recursive: true });

    // Hand the port over: a CLI-started daemon would collide with the
    // launchd copy the moment it boots.
    const state = getState(opts.dataDir);
    if (state && isPidAlive(state.pid)) {
      console.log(`Stopping the current NotFair (pid ${state.pid}) so launchd can own it…`);
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      await waitFor(() => !isPidAlive(state.pid), 10_000);
      clearState(opts.dataDir);
    }

    writeFileSync(plistPath(), renderPlist(Number.parseInt(opts.port, 10), opts.dataDir));
    await reloadLaunchAgent();

    const url = `http://127.0.0.1:${opts.port}`;
    const healthy = await waitFor(() => isHealthy(url), 30_000, 500);
    if (healthy) {
      console.log(`Autostart enabled — NotFair is running on ${url} and starts at every login.`);
    } else {
      console.log("Autostart enabled, but the server hasn't answered yet.");
      console.log("Check `notfair status` and `notfair logs`.");
      process.exit(1);
    }
  });

autostart
  .command("disable")
  .description("Remove the LaunchAgent and stop the launchd-managed server.")
  .action(async () => {
    requireDarwin();
    await runCheck("launchctl", ["bootout", launchdServiceTarget()]);
    try {
      unlinkSync(plistPath());
    } catch {}
    console.log("Autostart disabled; the launchd-managed server (if any) was stopped.");
  });

autostart
  .command("status")
  .description("Show whether the LaunchAgent is installed and loaded.")
  .action(async () => {
    requireDarwin();
    const enabled = existsSync(plistPath());
    if (!enabled) {
      console.log("Autostart is disabled. Enable with: notfair autostart enable");
      process.exit(1);
    }
    const loaded = await launchAgentLoaded();
    console.log(`Autostart is enabled (${plistPath()}).`);
    console.log(loaded ? "LaunchAgent is loaded." : "LaunchAgent loads at next login.");
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

// --- daemon state helpers ---

function stateFile(dataDir) {
  return join(dataDir, "server.json");
}

function logFile(dataDir) {
  return join(dataDir, "logs", "server.log");
}

function getState(dataDir) {
  try {
    const state = JSON.parse(readFileSync(stateFile(dataDir), "utf8"));
    if (!isPidAlive(state.pid)) {
      clearState(dataDir);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function writeState(dataDir, state) {
  writeFileSync(stateFile(dataDir), `${JSON.stringify(state, null, 2)}\n`);
}

function clearState(dataDir) {
  try {
    unlinkSync(stateFile(dataDir));
  } catch {}
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function isHealthy(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2_500),
      redirect: "manual",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

function printLogTail(dataDir, n) {
  try {
    const lines = readFileSync(logFile(dataDir), "utf8").trimEnd().split("\n");
    for (const line of lines.slice(-n)) console.log(line);
  } catch {}
}

function formatUptime(startedAt) {
  if (!startedAt) return "";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return " (just now)";
  if (min < 60) return ` (up ${min}m)`;
  const h = Math.floor(min / 60);
  if (h < 48) return ` (up ${h}h ${min % 60}m)`;
  return ` (up ${Math.floor(h / 24)}d)`;
}

// --- update helpers ---

async function fetchLatestVersion() {
  try {
    const res = await fetch("https://registry.npmjs.org/notfair/latest", {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/** True when `a` is strictly newer than `b` by major.minor.patch. */
function isVersionNewer(a, b) {
  const parse = (v) => v.split(/[-+]/)[0].split(".").map((n) => Number(n) || 0);
  const [amaj, amin, apat] = parse(a);
  const [bmaj, bmin, bpat] = parse(b);
  if (amaj !== bmaj) return amaj > bmaj;
  if (amin !== bmin) return amin > bmin;
  return apat > bpat;
}

/** The freshly-installed global CLI — stable across upgrades, unlike npx cache paths. */
async function globalCliPath() {
  const r = await runCheck("npm", ["root", "-g"], 15_000);
  if (!r.ok) return null;
  const cli = join(r.stdout.trim(), "notfair", "bin", "cli.mjs");
  return existsSync(cli) ? cli : null;
}

/** Run a command with inherited stdio; true on exit 0. */
function runInherit(cmd, args) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "inherit" });
    } catch {
      resolvePromise(false);
      return;
    }
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

// --- launchd helpers (macOS autostart) ---

function requireDarwin() {
  if (process.platform === "darwin") return;
  console.error("Autostart is only supported on macOS today (launchd).");
  console.error(
    "On Linux, create a systemd user unit that runs: notfair start --foreground --no-open",
  );
  process.exit(1);
}

function plistPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function launchdServiceTarget() {
  return `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
}

async function launchAgentLoaded() {
  if (process.platform !== "darwin") return false;
  const r = await runCheck("launchctl", ["print", launchdServiceTarget()]);
  return r.ok;
}

async function reloadLaunchAgent() {
  await runCheck("launchctl", ["bootout", launchdServiceTarget()]);
  const boot = await runCheck("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath()]);
  if (!boot.ok) {
    // Older macOS without bootstrap/bootout semantics.
    await runCheck("launchctl", ["load", "-w", plistPath()]);
  }
}

function xmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The LaunchAgent runs the CLI itself in --foreground so launchd supervises
 * a real process tree (RunAtLoad = start at login, KeepAlive = restart on
 * crash). PATH is captured from the enabling shell — launchd's default PATH
 * would hide the claude/codex binaries the agents need.
 */
function renderPlist(port, dataDir, cliPath = CLI_PATH) {
  const args = [
    process.execPath,
    cliPath,
    "start",
    "--foreground",
    "--no-open",
    "--port",
    String(port),
    "--data-dir",
    dataDir,
  ];
  const argStrings = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argStrings}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${xmlEscape(PKG_ROOT)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(logFile(dataDir))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile(dataDir))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
    <key>HOME</key><string>${xmlEscape(homedir())}</string>
    <key>NOTFAIR_MANAGED</key><string>launchd</string>
  </dict>
</dict>
</plist>
`;
}

/** Pull port/data-dir back out of the installed plist (regex, not a parser —
 *  we wrote the file, so the shape is known). */
function readPlistConfig() {
  try {
    const xml = readFileSync(plistPath(), "utf8");
    const strings = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    const port = Number.parseInt(strings[strings.indexOf("--port") + 1] ?? "", 10);
    const dataDir = strings[strings.indexOf("--data-dir") + 1] ?? DATA_DIR;
    // Anchor on the "start" argument: ProgramArguments is [node, cli, "start",
    // ...], but document order puts the Label's <string> first.
    const startIdx = strings.indexOf("start");
    return {
      port: Number.isFinite(port) ? port : 3327,
      dataDir,
      execPath: startIdx >= 2 ? strings[startIdx - 2] : null,
      cliPath: startIdx >= 1 ? strings[startIdx - 1] : null,
    };
  } catch {
    return null;
  }
}

/**
 * `notfair start` while autostart is enabled: launchd owns the server.
 * Heal a plist that points at a previous install (npx cache paths and
 * global-install realpaths move on upgrade), make sure the agent is
 * loaded, and wait for health — never spawn a competing daemon.
 */
async function startViaLaunchd(opts) {
  const cfg = readPlistConfig();
  const port = cfg?.port ?? 3327;
  const url = `http://127.0.0.1:${port}`;
  const desired = Number.parseInt(opts.port, 10);
  if (Number.isFinite(desired) && desired !== port && opts.port !== "3327") {
    console.log(
      `Autostart is enabled on port ${port}; ignoring --port ${desired}. Re-run \`notfair autostart enable --port ${desired}\` to move it.`,
    );
  }

  const stale =
    (cfg?.cliPath && cfg.cliPath !== CLI_PATH) ||
    (cfg?.execPath && cfg.execPath !== process.execPath);
  if (stale) {
    writeFileSync(plistPath(), renderPlist(port, cfg.dataDir));
    console.log("Refreshed the login autostart entry to this NotFair install.");
    await reloadLaunchAgent();
  } else if (await isHealthy(url)) {
    console.log(`NotFair is already running on ${url} (launchd-managed).`);
    if (opts.open !== false) await open(url).catch(() => {});
    return;
  } else if (await launchAgentLoaded()) {
    await runCheck("launchctl", ["kickstart", launchdServiceTarget()]);
  } else {
    await reloadLaunchAgent();
  }

  const healthy = await waitFor(() => isHealthy(url), 30_000, 500);
  if (!healthy) {
    console.error(`launchd did not bring NotFair up on ${url} within 30s.`);
    console.error(`Check \`notfair logs\` (${logFile(cfg?.dataDir ?? DATA_DIR)}).`);
    process.exit(1);
  }
  console.log(`NotFair running on ${url} (launchd-managed).`);
  if (opts.open !== false) {
    await open(url).catch(() => {
      console.log(`Open ${url} in your browser.`);
    });
  }
}

// --- helpers ---

function ensureStandaloneAssets() {
  const standaloneStatic = join(PKG_ROOT, ".next", "standalone", ".next", "static");
  const sourceStatic = join(PKG_ROOT, ".next", "static");
  if (!existsSync(standaloneStatic) && existsSync(sourceStatic)) {
    cpSync(sourceStatic, standaloneStatic, { recursive: true });
  }
  const standalonePublic = join(PKG_ROOT, ".next", "standalone", "public");
  const sourcePublic = join(PKG_ROOT, "public");
  if (!existsSync(standalonePublic) && existsSync(sourcePublic)) {
    cpSync(sourcePublic, standalonePublic, { recursive: true });
  }
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function ensureDataDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function findFreePort(start, maxTries = 5) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port) => {
      const server = createServer();
      server.once("error", (err) => {
        server.close();
        if (err.code === "EADDRINUSE" && attempt < maxTries) {
          attempt += 1;
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(port));
      });
    };
    tryPort(start);
  });
}

function runCheck(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", () => finish({ ok: false, stdout: "", stderr: "" }));
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout, stderr });
    });
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
        finish({ ok: false, stdout, stderr: "timed out" });
      }
    }, timeoutMs).unref?.();
  });
}

// --- doctor helpers ---

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function useColor() {
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function color(name, text) {
  if (!useColor()) return text;
  return `${COLORS[name]}${text}${COLORS.reset}`;
}

function pass(name, detail) {
  return { name, status: "pass", ok: true, detail };
}
function fail(name, detail, fix) {
  return { name, status: "fail", ok: false, detail, fix };
}
function skipped(name, detail) {
  return { name, status: "skip", ok: false, detail };
}

function checkNodeVersion() {
  const raw = process.versions.node;
  const major = Number.parseInt(raw.split(".")[0], 10);
  if (Number.isNaN(major)) {
    return fail("Node version", `unrecognized: ${raw}`, "Install Node 20+ (24 recommended) — https://nodejs.org");
  }
  if (major < 20) {
    return fail(
      "Node version",
      `v${raw} (need ≥20)`,
      "Install Node 20+ (24 recommended) — https://nodejs.org, or use nvm: nvm install 24",
    );
  }
  const note = major >= 24 ? "" : " — 24 recommended";
  return pass("Node version", `v${raw}${note}`);
}

async function checkHarnessInstalled(label, binary) {
  const r = await runCheck(binary, ["--version"]);
  if (!r.ok) {
    return fail(
      `${label} installed`,
      "not on PATH",
      label === "Claude Code"
        ? "Install: https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview"
        : "Install: https://github.com/openai/codex",
    );
  }
  return pass(`${label} installed`, r.stdout.trim().split("\n")[0] || "ok");
}

function checkDataDir(dir) {
  const overrideEnv = process.env.NOTFAIR_DATA_DIR;
  const source = overrideEnv ? "NOTFAIR_DATA_DIR" : dir === DATA_DIR ? "default" : "--data-dir";
  try {
    ensureDataDir(dir);
    const probe = join(dir, ".doctor-write-probe");
    writeFileSync(probe, String(Date.now()));
    unlinkSync(probe);
    return pass("Data dir writable", `${dir} (${source})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      "Data dir writable",
      `${dir}: ${message}`,
      "Pass --data-dir <path> or set NOTFAIR_DATA_DIR to a writable directory",
    );
  }
}

async function checkPortAvailable(preferred) {
  if (!Number.isFinite(preferred) || preferred <= 0) {
    return fail(
      "Port available",
      `invalid preferred port: ${preferred}`,
      "Pass --port <n> with a valid TCP port (1-65535)",
    );
  }
  try {
    const port = await findFreePort(preferred, 5);
    const detail =
      port === preferred ? `${preferred}` : `${port} (preferred ${preferred} was busy)`;
    return pass("Port available", detail);
  } catch {
    return fail(
      "Port available",
      `none free in ${preferred}–${preferred + 5}`,
      `Pass --port <n> with a free port (ports ${preferred}–${preferred + 5} are all in use)`,
    );
  }
}

function printResults(results) {
  const nameWidth = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const pad = " ".repeat(nameWidth - r.name.length);
    const icon =
      r.status === "pass"
        ? color("green", "✓")
        : r.status === "fail"
          ? color("red", "✗")
          : color("yellow", "-");
    const label =
      r.status === "pass"
        ? color("green", r.name)
        : r.status === "fail"
          ? color("red", r.name)
          : color("yellow", r.name);
    const detail = r.detail ? `  ${color("dim", r.detail)}` : "";
    console.log(`${icon} ${label}${pad}${detail}`);
    if (r.status === "fail" && r.fix) {
      console.log(`  ${color("bold", "Fix:")} ${r.fix}`);
    }
    if (r.status === "skip" && r.detail) {
      // detail already printed above; no extra line
    }
  }
  console.log("");
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  if (failed === 0 && skipped === 0) {
    console.log(color("green", "All checks passed. You're ready to run NotFair."));
  } else if (failed === 0) {
    console.log(
      color("yellow", `Passed, with ${skipped} check${skipped === 1 ? "" : "s"} skipped.`),
    );
  } else {
    console.log(
      color(
        "red",
        `${failed} check${failed === 1 ? "" : "s"} failed${skipped ? `, ${skipped} skipped` : ""}.`,
      ),
    );
  }
}
