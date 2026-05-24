import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "keytar"],
  // typedRoutes intentionally disabled in V1 — our nav table builds Link hrefs
  // dynamically. Re-enable once the route map settles and Link wrappers can
  // be properly typed.
};

export default config;
