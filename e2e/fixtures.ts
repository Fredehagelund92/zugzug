/**
 * Shared test helpers. Import from here in specs rather than from
 * @playwright/test directly when you need the extended fixtures.
 *
 * `uniqueSuffix()` generates a short random string for scoping test data
 * (workspace names, email addresses, etc.) so parallel runs don't collide.
 */
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/** Returns a short random alphanumeric suffix, e.g. "a3f9". */
export function uniqueSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

// Re-export the base test fixture unchanged for now. Later tasks may extend it
// (e.g. add `adminPage`, `editorPage` fixtures).
export const test = base;
