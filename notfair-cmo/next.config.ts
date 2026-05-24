import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "keytar"],
  // pnpm + standalone output drops transitive deps that Next.js's own
  // compiled chunks require at runtime (e.g. @swc/helpers, @next/env).
  // Force-include them so the published tarball boots.
  outputFileTracingIncludes: {
    "*": [
      "./node_modules/@swc/helpers/**/*",
      "./node_modules/@next/env/**/*",
    ],
  },
  // typedRoutes intentionally disabled in V1 — our nav table builds Link hrefs
  // dynamically. Re-enable once the route map settles and Link wrappers can
  // be properly typed.
};

export default config;
