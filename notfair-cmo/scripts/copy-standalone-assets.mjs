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

// Dereference symlinks in-place so npm pack ships real files. We pipe `tar
// -ch | tar -x` because it follows chained pnpm symlinks correctly during
// archive creation. Earlier approaches (`cp -RL`, `rsync -aL`) silently
// dropped entries whose symlink chain had any dangling link, which produced
// broken standalone bundles missing transitive deps like `@swc/helpers` and
// `@next/env`.
const DEREF = STANDALONE + ".deref-tmp";
rmSync(DEREF, { recursive: true, force: true });
const parent = dirname(STANDALONE);
const standaloneName = basename(STANDALONE);
const derefName = basename(DEREF);
// tar -h dereferences symlinks during archive creation; the second tar
// extracts. Both run inside the parent dir so relative paths stay clean.
// 2>/dev/null on the first tar swallows the warnings about dangling pnpm
// links that we intentionally want to skip.
execSync(
  `mkdir -p "${derefName}" && tar -ch -f - -C "${standaloneName}" . 2>/dev/null | tar -x -C "${derefName}"`,
  { cwd: parent, stdio: "inherit", shell: "/bin/bash" },
);
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
