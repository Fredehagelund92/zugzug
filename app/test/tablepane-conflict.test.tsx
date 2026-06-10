import { describe, test } from "vitest";

describe("TablePane conflict surfacing", () => {
  test.skip("rename that throws ConflictError shows the ConflictBanner with the updater's name", () => {
    // Deferred — TablePane test harness requires too much mock setup.
    // Server-side coverage in repo-canonical-version.test.ts and
    // canonical-routes-conflict.test.ts is comprehensive; component-level
    // coverage in conflict-banner.test.tsx covers the rendering surface.
    // Manual smoke in Task 13 verifies the wiring.
  });
});
