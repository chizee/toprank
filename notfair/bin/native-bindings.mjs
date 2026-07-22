import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * npm builds the top-level better-sqlite3 dependency for the Node.js version
 * that installed NotFair. Next.js also ships traced copies compiled on the
 * release builder, so refresh those copies before every server start.
 */
export function syncStandaloneNativeBindings(packageRoot) {
  const runtimeBinding = join(
    packageRoot,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
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
