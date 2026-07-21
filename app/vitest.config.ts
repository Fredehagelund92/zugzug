import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
    // Under parallel file execution on a loaded machine, even synchronous
    // render tests intermittently exceed vitest's 5s default (observed across
    // unrelated files run-to-run). Per-file overrides proved whack-a-mole —
    // the contention is suite-wide, so the default is raised globally.
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      exclude: [
        "**/*.test.*",
        "**/test-kit/**",
        "test/**",
        "src/main.tsx",
        "**/*.d.ts",
        "**/verify-*.ts",
      ],
    },
  },
});
