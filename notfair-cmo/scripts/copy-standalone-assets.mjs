#!/usr/bin/env node
// Next.js standalone output (`output: "standalone"`) intentionally does NOT
// include `.next/static/` or `public/` so they can be served from a CDN in
// production. We ship as a local-first npm package, so we copy them into the
// standalone tree where `server.js` will serve them automatically.
//
// We also dereference every symlink under .next/standalone/. With pnpm, the
// standalone tree is full of symlinks into .pnpm/<pkg>@<ver>/... and
// .next/node_modules/<pkg>-<hash> aliases that Turbopack emits for externals.
// `npm pack` drops these symlinks, so the published tarball can't resolve
// modules like better-sqlite3. Replacing them with real copies makes the
// tarball self-contained at the cost of some size.

import { existsSync, cpSync, lstatSync, readdirSync, realpathSync, rmSync, renameSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const STANDALONE = join(ROOT, ".next", "standalone");

if (!existsSync(STANDALONE)) {
  console.error(`No standalone output found at ${STANDALONE}. Did 'next build' run?`);
  process.exit(1);
}

const targets = [
  { src: join(ROOT, ".next", "static"), dest: join(STANDALONE, ".next", "static") },
  { src: join(ROOT, "public"), dest: join(STANDALONE, "public") },
];

for (const { src, dest } of targets) {
  if (!existsSync(src)) continue;
  cpSync(src, dest, { recursive: true });
  console.log(`Copied ${src.replace(ROOT + "/", "")} → ${dest.replace(ROOT + "/", "")}`);
}

// Dereference symlinks in-place so npm pack ships real files. We use `cp -RL`
// via the system shell because Node's cpSync has trouble with the pnpm-style
// symlink layout (multiple symlinks pointing into the same .pnpm dir create
// cpSync EISDIR errors).
const DEREF = STANDALONE + ".deref-tmp";
rmSync(DEREF, { recursive: true, force: true });
const parent = dirname(STANDALONE);
const standaloneName = basename(STANDALONE);
// `cp -RL` exits 1 on any dangling symlink it encounters (pnpm sometimes
// leaves a `.pnpm/node_modules/semver` symlink with no target). The copy
// still completes successfully — the dangling entry is just dropped. We
// verify the result via countSymlinks() below rather than relying on cp's
// exit code.
try {
  execSync(`cp -RL "${standaloneName}" "${basename(DEREF)}"`, { cwd: parent, stdio: "inherit" });
} catch (err) {
  if (!existsSync(DEREF)) throw err;
}
rmSync(STANDALONE, { recursive: true, force: true });
renameSync(DEREF, STANDALONE);
console.log(`Dereferenced symlinks under ${STANDALONE.replace(ROOT + "/", "")}`);

// Sanity check: there should be no symlinks left in standalone after dereferencing.
const remaining = countSymlinks(STANDALONE);
if (remaining > 0) {
  console.warn(`Warning: ${remaining} symlinks still present under .next/standalone/`);
}

function countSymlinks(dir) {
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      count += 1;
    } else if (st.isDirectory()) {
      count += countSymlinks(p);
    }
  }
  return count;
}
