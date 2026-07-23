import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

function runtimeBindingPath(packageRoot) {
  return join(
    packageRoot,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
}

function packagePrefixNode(packageRoot, platform = process.platform) {
  const prefix = dirname(dirname(dirname(packageRoot)));
  return platform === "win32" ? join(prefix, "node.exe") : join(prefix, "bin", "node");
}

function probeNativeBinding(nodePath, bindingPath) {
  const result = spawnSync(
    nodePath,
    ["-e", "require(process.argv[1])", bindingPath],
    { stdio: "ignore", timeout: 5_000 },
  );
  return result.status === 0 && !result.error;
}

/**
 * A globally installed CLI can be launched through a different Node manager
 * than the one npm used for installation. Native addons belong to the
 * installing Node ABI, so run the standalone server with a Node executable
 * that can actually load the installed binding.
 */
export function resolveCompatibleNodeRuntime(
  packageRoot,
  {
    execPath = process.execPath,
    platform = process.platform,
    probe = probeNativeBinding,
  } = {},
) {
  const binding = runtimeBindingPath(packageRoot);
  if (!existsSync(binding)) return execPath;

  const candidates = [
    ...new Set([execPath, packagePrefixNode(packageRoot, platform)]),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && probe(candidate, binding)) return candidate;
  }

  throw new Error(
    `The installed better-sqlite3 binding is incompatible with the available Node.js runtimes. ` +
      `Reinstall NotFair with the active Node.js version: npm install -g notfair@latest`,
  );
}

/**
 * npm builds the top-level better-sqlite3 dependency for the Node.js version
 * that installed NotFair. Next.js also ships traced copies compiled on the
 * release builder, so refresh those copies before every server start.
 */
export function syncStandaloneNativeBindings(packageRoot) {
  const runtimeBinding = runtimeBindingPath(packageRoot);
  if (!existsSync(runtimeBinding)) return 0;

  const targets = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name === "better_sqlite3.node") {
        targets.push(path);
      }
    }
  };
  visit(join(packageRoot, ".next", "standalone"));

  for (const target of targets) copyFileSync(runtimeBinding, target);
  return targets.length;
}
