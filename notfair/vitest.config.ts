import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // Testing-library auto-cleanup registers on the global afterEach.
    globals: true,
    // Only first-party tests — `next build` copies src (tests included)
    // into .next/standalone, which vitest must not collect.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    // Server modules and libs run in node. Component tests opt into a DOM
    // per-file via `// @vitest-environment jsdom` (vitest 4 removed the
    // environmentMatchGlobs shorthand).
    environment: "node",
    coverage: {
      provider: "v8",
      // The denominator is everything we unit-test by convention. Excluded
      // per CLAUDE.md: Next.js pages/layouts/route handlers (live smoke
      // covers those), vendored shadcn primitives, and the boot hook.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/app/**",
        "src/components/ui/**",
        "src/instrumentation.ts",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/types.ts",
      ],
      thresholds: {
        statements: 80,
        lines: 80,
      },
    },
  },
});
