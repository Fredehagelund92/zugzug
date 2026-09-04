/**
 * POST /api/t/:slug/tables/:id/suggest costs a paid provider call per request
 * (force_refresh skips the cache and guarantees one), so an unlimited caller
 * bills real money rather than merely burning CPU. checkRateLimit was wired
 * into the /v1/ surface and the password endpoints, but not here.
 *
 * The budget is per WORKSPACE because the workspace is what pays. Both
 * properties are asserted: that it engages, and that it is scoped — a global
 * limiter would let one workspace deny AI suggestions to every other.
 */
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { pg as pgTable, env } from "../src/env.ts";
import { provisionTenant } from "../src/tenant.ts";

/* env is read once at module load and static imports are hoisted above any
   process.env assignment in this file, so the budget is overridden in place —
   the idiom auth-dev-bypass.test.ts uses. A small budget keeps the test fast
   and its intent legible. */
const BUDGET = 5;
let savedRpm = 0;

const WS_A = "airl_a";
const WS_B = "airl_b";

async function member(tenantId: string): Promise<string> {
  try {
    await provisionTenant({ id: tenantId, label: tenantId });
  } catch {
    // already provisioned by an earlier test in this file
  }
  const userId = `u_${tenantId}_${Math.random().toString(36).slice(2, 8)}`;
  await pgRun(
    `INSERT INTO ${pgTable("users")} (id, name, initials, email, is_super_admin)
     VALUES ($1, 'AI RL', 'AR', $2, false) ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@example.com`],
  );
  await pgRun(
    `INSERT INTO ${pgTable("tenant_member")} (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'editor', now()) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    [tenantId, userId],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

/** The limit is checked before the table is looked up, so an unthrottled call
 *  answers 404 for a table that does not exist. That is what makes 429 vs 404
 *  a clean signal here — no AI provider or fixture table is needed. */
async function suggest(tenantId: string, cookie: string): Promise<Response> {
  const { handle } = await import("../src/server.ts");
  return handle(
    new Request(`http://localhost/api/t/${tenantId}/tables/no_such_table/suggest`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ raw_value: "acme corp", force_refresh: true }),
    }),
    () => {},
  );
}

beforeEach(async () => {
  savedRpm = env.aiRpm;
  (env as { aiRpm: number }).aiRpm = BUDGET;
  // Scoped to this file's own keys: the table is shared with the auth and
  // Pull-API limiters, and wiping it wholesale would clear their counters too.
  await pgRun(
    `DELETE FROM ${pgTable("auth_credential_quota")} WHERE credential_id LIKE 'ai:airl_%'`,
  );
});
afterEach(() => {
  (env as { aiRpm: number }).aiRpm = savedRpm;
});

test("a workspace's AI budget is spent, then refused with 429 + Retry-After", async () => {
  const cookie = await member(WS_A);

  for (let i = 0; i < BUDGET; i++) {
    const r = await suggest(WS_A, cookie);
    expect(r.status).not.toBe(429);
  }

  const blocked = await suggest(WS_A, cookie);
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ error: "RATE_LIMITED" });
  const retryAfter = Number(blocked.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
});

test("the budget is per workspace — one spending it does not block another", async () => {
  const aCookie = await member(WS_A);
  const bCookie = await member(WS_B);

  for (let i = 0; i < BUDGET + 1; i++) await suggest(WS_A, aCookie);
  expect((await suggest(WS_A, aCookie)).status).toBe(429);

  // A global limiter would refuse this too, letting any workspace deny AI
  // suggestions to every other one.
  expect((await suggest(WS_B, bCookie)).status).not.toBe(429);
});

/* Leaving the fixtures behind makes this file's effect on any later test
   depend on run order, which is exactly the kind of thing that passes locally
   and fails elsewhere. */
afterAll(async () => {
  for (const t of [WS_A, WS_B]) {
    await pgRun(`DELETE FROM ${pgTable("audit_log")} WHERE tenant_id = $1`, [t]).catch(() => {});
    await pgRun(`DELETE FROM ${pgTable("tenant_member")} WHERE tenant_id = $1`, [t]).catch(
      () => {},
    );
    await pgRun(`DELETE FROM ${pgTable("sessions")} WHERE user_id LIKE $1`, [`u_${t}_%`]).catch(
      () => {},
    );
    await pgRun(`DELETE FROM ${pgTable("users")} WHERE id LIKE $1`, [`u_${t}_%`]).catch(() => {});
    await pgRun(`DELETE FROM ${pgTable("tenant")} WHERE id = $1`, [t]).catch(() => {});
  }
  await pgRun(
    `DELETE FROM ${pgTable("auth_credential_quota")} WHERE credential_id LIKE 'ai:airl_%'`,
  ).catch(() => {});
});
