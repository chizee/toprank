#!/usr/bin/env node
// notfair-cmo CLI entry point.
// Compiled-free: stays as plain ESM JS so it works straight from npm without a build step
// for the CLI surface. The Next.js app itself is built and shipped under .next/standalone.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  cpSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, Socket } from "node:net";
import { Command } from "commander";
import open from "open";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(__dirname);
const DATA_DIR = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");

const program = new Command();
program
  .name("notfair-cmo")
  .description("Local AI marketing CMO portal. Orchestrates OpenClaw marketing agents.")
  .version(readPackageVersion());

program
  .command("start", { isDefault: true })
  .description("Start the local server and open the UI in your browser.")
  .option("-p, --port <port>", "Port to bind", "3000")
  .option("--no-open", "Do not auto-open the browser")
  .option("--data-dir <dir>", "Override data directory", DATA_DIR)
  .action(async (opts) => {
    const desired = Number.parseInt(opts.port, 10);
    const port = await findFreePort(desired);
    if (port !== desired) {
      console.log(`Port ${desired} was busy, using ${port} instead.`);
    }

    ensureDataDir(opts.dataDir);

    const standalonePath = join(PKG_ROOT, ".next", "standalone", "server.js");
    if (!existsSync(standalonePath)) {
      console.error("Build artifacts not found. This usually means you're running");
      console.error("from source without a build. Run: pnpm build");
      console.error(`Expected: ${standalonePath}`);
      process.exit(2);
    }

    // Next.js standalone output omits .next/static and public by default; copy
    // them in if they're missing so the server can serve CSS/JS chunks.
    ensureStandaloneAssets();

    const url = `http://127.0.0.1:${port}`;
    const child = spawn("node", [standalonePath], {
      stdio: "inherit",
      env: {
        ...process.env,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        NOTFAIR_CMO_DATA_DIR: opts.dataDir,
      },
    });

    console.log(`notfair-cmo running on ${url}`);

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
  });

program
  .command("doctor")
  .description("Verify this machine is ready to run notfair-cmo.")
  .option("--data-dir <dir>", "Override data directory", DATA_DIR)
  .option("-p, --port <port>", "Preferred port for the server", "3000")
  .action(async (opts) => {
    const results = [];

    const node = checkNodeVersion();
    results.push(node);

    let openclaw;
    if (node.ok) {
      openclaw = await checkOpenclawInstalled();
    } else {
      openclaw = skipped("OpenClaw installed", "node version too old");
    }
    results.push(openclaw);

    let gateway;
    if (openclaw.ok) {
      gateway = await checkOpenclawGateway();
    } else {
      gateway = skipped("OpenClaw gateway reachable", "openclaw not installed");
    }
    results.push(gateway);

    let llm;
    if (openclaw.ok) {
      llm = await checkLLMProvider();
    } else {
      llm = skipped("LLM provider configured", "openclaw not installed");
    }
    results.push(llm);

    const dataDir = checkDataDir(opts.dataDir);
    results.push(dataDir);

    const port = await checkPortAvailable(Number.parseInt(opts.port, 10));
    results.push(port);

    printResults(results);

    const failed = results.filter((r) => r.status === "fail").length;
    process.exit(failed === 0 ? 0 : 1);
  });

program
  .command("stop")
  .description("Stop any running notfair-cmo instances on this machine.")
  .action(() => {
    console.log("Stop is not implemented yet. Use Ctrl+C in the running terminal,");
    console.log("or kill the node process bound to your notfair-cmo port.");
    process.exit(1);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

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

async function checkOpenclawInstalled() {
  const r = await runCheck("openclaw", ["--version"]);
  if (!r.ok) {
    return fail(
      "OpenClaw installed",
      "not on PATH",
      "Install OpenClaw — https://docs.openclaw.ai/install",
    );
  }
  return pass("OpenClaw installed", r.stdout.trim().split("\n")[0] || "ok");
}

async function checkOpenclawGateway() {
  const portR = await runCheck("openclaw", ["config", "get", "gateway.port"]);
  const port = portR.ok ? Number.parseInt(portR.stdout.trim(), 10) : NaN;
  const targetPort = Number.isFinite(port) ? port : 18789;

  const health = await runCheck("openclaw", ["health"]);
  if (health.ok) {
    return pass("OpenClaw gateway", `reachable on ws://127.0.0.1:${targetPort}`);
  }

  const wsReachable = await pingLoopback(targetPort);
  if (wsReachable) {
    return pass("OpenClaw gateway", `reachable on ws://127.0.0.1:${targetPort}`);
  }
  return fail(
    "OpenClaw gateway",
    `not reachable on ws://127.0.0.1:${targetPort}`,
    "Start it with: openclaw gateway",
  );
}

function pingLoopback(port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, "127.0.0.1");
    } catch {
      finish(false);
    }
  });
}

async function checkLLMProvider() {
  const modelR = await runCheck("openclaw", ["config", "get", "agents.defaults.model"]);
  if (!modelR.ok) {
    return fail(
      "LLM provider configured",
      "could not read agents.defaults.model from OpenClaw config",
      "Configure a default model: openclaw configure --section models",
    );
  }

  let chainCfg;
  try {
    chainCfg = JSON.parse(modelR.stdout);
  } catch {
    return fail(
      "LLM provider configured",
      "agents.defaults.model is not valid JSON",
      "Re-run interactive setup: openclaw configure --section models",
    );
  }

  const primary = typeof chainCfg?.primary === "string" ? chainCfg.primary : null;
  const fallbacks = Array.isArray(chainCfg?.fallbacks)
    ? chainCfg.fallbacks.filter((m) => typeof m === "string")
    : [];
  const chain = [primary, ...fallbacks].filter(Boolean);
  if (chain.length === 0) {
    return fail(
      "LLM provider configured",
      "no models in agents.defaults.model chain",
      "Set a primary model: openclaw configure --section models",
    );
  }

  const providers = chain.map((m) => m.split("/")[0]).filter(Boolean);
  const uniqueProviders = Array.from(new Set(providers));

  const providersR = await runCheck("openclaw", ["config", "get", "models.providers"]);
  let providerCfg = {};
  if (providersR.ok) {
    try {
      providerCfg = JSON.parse(providersR.stdout) ?? {};
    } catch {
      providerCfg = {};
    }
  }

  const configured = uniqueProviders.filter((p) => {
    const entry = providerCfg[p];
    if (entry && typeof entry === "object") {
      const hasKey =
        typeof entry.apiKey === "string" && entry.apiKey.length > 0 && !entry.apiKey.startsWith("__");
      const hasBaseUrl = typeof entry.baseUrl === "string" && entry.baseUrl.length > 0;
      if (hasKey || hasBaseUrl) return true;
    }
    return providerHasEnvKey(p);
  });

  if (configured.length === 0) {
    return fail(
      "LLM provider configured",
      `none of [${uniqueProviders.join(", ")}] are configured`,
      `Configure a provider: openclaw configure --section models  (chain: ${chain.join(" → ")})`,
    );
  }

  const primaryProvider = providers[0];
  const primaryReady = configured.includes(primaryProvider);
  const detail = primaryReady
    ? `${primaryProvider} (primary: ${primary})`
    : `${configured[0]} (fallback; primary ${primaryProvider} not configured)`;
  return pass("LLM provider configured", detail);
}

function providerHasEnvKey(provider) {
  const candidates = {
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    gemini: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    groq: ["GROQ_API_KEY"],
    xai: ["XAI_API_KEY"],
  };
  const vars = candidates[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
  return vars.some((v) => !!process.env[v]);
}

function checkDataDir(dir) {
  const overrideEnv = process.env.NOTFAIR_CMO_DATA_DIR;
  const source = overrideEnv ? "NOTFAIR_CMO_DATA_DIR" : dir === DATA_DIR ? "default" : "--data-dir";
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
      "Pass --data-dir <path> or set NOTFAIR_CMO_DATA_DIR to a writable directory",
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
    console.log(color("green", "All checks passed. You're ready to run notfair-cmo."));
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
