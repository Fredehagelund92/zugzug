process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { updateUserName, issueSession } from "../src/auth.ts";
import { pgGet } from "../src/pg.ts";
import { AppError } from "../src/errors.ts";

beforeEach(async () => {
  await resetDb();
});

test("updateUserName updates the user's display name", async () => {
  // Create a user via SQL
  const userId = "u_profile_test";
  await (await import("../src/pg.ts")).pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, 'Original Name', 'ON', $2, 'editor', false)`,
    [userId, `${userId}@example.com`],
  );

  // Update the name
  await updateUserName(userId, "New Name");

  // Verify
  const row = await pgGet<{ name: string }>(
    `SELECT name FROM "zugzug_app"."users" WHERE id = $1`,
    [userId],
  );
  expect(row?.name).toBe("New Name");
});

test("updateUserName trims whitespace from name", async () => {
  const userId = "u_profile_trim";
  await (await import("../src/pg.ts")).pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, 'Original', 'ON', $2, 'editor', false)`,
    [userId, `${userId}@example.com`],
  );

  await updateUserName(userId, "  Trimmed Name  ");

  const row = await pgGet<{ name: string }>(
    `SELECT name FROM "zugzug_app"."users" WHERE id = $1`,
    [userId],
  );
  expect(row?.name).toBe("Trimmed Name");
});

test("updateUserName rejects empty name", async () => {
  const userId = "u_profile_empty";
  await (await import("../src/pg.ts")).pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, 'Original', 'ON', $2, 'editor', false)`,
    [userId, `${userId}@example.com`],
  );

  try {
    await updateUserName(userId, "   ");
    expect(true).toBe(false); // Should have thrown
  } catch (e) {
    expect(e instanceof AppError).toBe(true);
    if (e instanceof AppError) {
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(e.status).toBe(400);
    }
  }
});
