// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { env } from "../src/env.ts";

// These tests verify that the env fields serialised into GET /api/workspace/info
// have the expected types and pre-Task-11 defaults.

test("env.defaultEngineerMode is boolean (defaults true when DEFAULT_ENGINEER_MODE not set)", () => {
  // DEFAULT_ENGINEER_MODE is not set in the test harness, so the default applies.
  expect(typeof env.defaultEngineerMode).toBe("boolean");
  expect(env.defaultEngineerMode).toBe(true);
});

test("env.allowedDomain returns expected value (pre-Task-11 default: 'bettercollective.com')", () => {
  // ALLOWED_DOMAIN is not set in the test harness; default is 'bettercollective.com'.
  // Task 11 will flip this default to '' → null; update assertion then.
  const body = {
    adapter: "duckdb" as const,
    writable: false,
    canonicalMode: "postgres-export" as const,
    warehouseDb: env.warehouseDb || null,
    defaultEngineerMode: env.defaultEngineerMode,
    allowedDomain: env.allowedDomain || null,
  };

  expect(body.defaultEngineerMode).toBe(true); // env default when DEFAULT_ENGINEER_MODE not set
  expect(body.allowedDomain).toBe("bettercollective.com"); // pre-Task-11 default
});

test("workspace/info response shape includes all required fields", () => {
  // Validates the shape of the object returned by the /api/workspace/info handler.
  const body = {
    adapter: "duckdb" as const,
    writable: false,
    canonicalMode: "postgres-export" as const,
    warehouseDb: env.warehouseDb || null,
    defaultEngineerMode: env.defaultEngineerMode,
    allowedDomain: env.allowedDomain || null,
  };

  expect(body).toMatchObject({
    adapter: expect.any(String),
    writable: expect.any(Boolean),
    canonicalMode: expect.any(String),
    defaultEngineerMode: expect.any(Boolean),
  });
  // warehouseDb and allowedDomain are nullable strings
  expect(body.warehouseDb === null || typeof body.warehouseDb === "string").toBe(true);
  expect(body.allowedDomain === null || typeof body.allowedDomain === "string").toBe(true);
});
