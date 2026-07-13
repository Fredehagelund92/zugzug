import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
    // Several test files use vi.resetModules() + vi.doMock() + await import() on
    // heavy components (e.g. Triage.tsx, 1100 lines) and do this per-test.
    // Under the full 79-file parallel run on a 10-core machine each such cycle
    // can approach 12 s of wall time.  The 5 s default fires spuriously; 15 s
    // gives headroom without masking genuine hangs.
    testTimeout: 15000,
  },
});
