process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgGet, pgRun } from "../src/pg.ts";
import { env } from "../src/env.ts";
import { handle } from "../src/server.ts";

/** env.devBypassAuth is resolved once at import time — and bun loads
 *  server/.env before any preload, so a developer with DEV_BYPASS_AUTH=true
 *  there starts from the opposite value. Pin the resolved value for the
 *  duration of the call (same idiom as scheduler-jobs.test.ts). */
async function withDevBypass(on: boolean, fn: () => Promise<Response>): Promise<Response> {
  const saved = env.devBypassAuth;
  (env as { devBypassAuth: boolean }).devBypassAuth = on;
  try {
    return await fn();
  } finally {
    (env as { devBypassAuth: boolean }).devBypassAuth = saved;
  }
}

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = 'u_dev'`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = 'u_dev'`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = 'u_dev'`).catch(() => {});
}
beforeEach(cleanup);
afterAll(cleanup);

test("GET /api/auth/dev only reports the flag — no cookie, no user, no session", async () => {
  const res = await withDevBypass(true, () =>
    handle(new Request("http://localhost/api/auth/dev"), () => {}),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ enabled: true });
  expect(res.headers.getSetCookie()).toHaveLength(0);
  expect(await pgGet(`SELECT id FROM "zugzug_app"."users" WHERE id = 'u_dev'`)).toBeNull();
  expect(await pgGet(`SELECT id FROM "zugzug_app"."sessions" WHERE user_id = 'u_dev'`)).toBeNull();
});

test("POST /api/auth/dev is the login — it issues the session cookie", async () => {
  const res = await withDevBypass(true, () =>
    handle(new Request("http://localhost/api/auth/dev", { method: "POST" }), () => {}),
  );
  expect(res.status).toBe(204);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("zz_sid="))).toBe(true);
  expect(
    await pgGet(`SELECT id FROM "zugzug_app"."sessions" WHERE user_id = 'u_dev'`),
  ).not.toBeNull();
});

test("GET /api/auth/dev is 404 when the bypass is off", async () => {
  const res = await withDevBypass(false, () =>
    handle(new Request("http://localhost/api/auth/dev"), () => {}),
  );
  expect(res.status).toBe(404);
});
