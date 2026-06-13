process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect } from "bun:test";
import { pgAll, pgTxScoped } from "../src/pg.ts";

test("SELECT on dimension WITH SET LOCAL works (inside pgTxScoped)", async () => {
  await pgTxScoped("default", async () => {
    const rows = await pgAll(`SELECT id FROM "zugzug_app"."dimension" LIMIT 5`);
    expect(Array.isArray(rows)).toBe(true);
  });
});

test("11 scoped tables have RLS enabled", async () => {
  const rows = await pgAll<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'zugzug_app' AND rowsecurity = true ORDER BY tablename`,
    [],
  );
  expect(rows.length).toBe(11);
});

test("Each scoped table has a tenant_iso policy", async () => {
  const rows = await pgAll<{ tablename: string; policyname: string }>(
    `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'zugzug_app' ORDER BY tablename`,
    [],
  );
  expect(rows.length).toBe(11);
  for (const r of rows) {
    expect(r.policyname).toBe("tenant_iso");
  }
});
