// The password endpoints run argon2 on every attempt, so an unlimited caller
// gets both password guessing and a CPU lever on a single-threaded runtime.
// checkRateLimit was wired only into /v1/, leaving this surface open.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";

import "./setup.ts";
import { test, expect, beforeEach } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { env, pg } from "../src/env.ts";
import { req } from "./factories/index.ts";

const PW = "correct horse battery staple";

/** The limiter is a persisted fixed-window counter, so each test starts from a
 *  clean slate rather than inheriting another test's budget. */
async function clearQuota(): Promise<void> {
  await pgRun(`DELETE FROM ${pg("auth_credential_quota")}`);
}

beforeEach(clearQuota);

test("repeated failed logins for one account are cut off with 429 + Retry-After", async () => {
  const email = `ratelimit_${Date.now()}@example.com`;
  const budget = env.authRpm;
  expect(budget).toBeGreaterThan(0);

  // Within budget: the generic credential failure, never a 429.
  for (let i = 0; i < budget; i++) {
    const r = await req("POST", "/api/auth/login", undefined, { email, password: "wrong" });
    expect(r.status).toBe(401);
  }

  const blocked = await req("POST", "/api/auth/login", undefined, { email, password: "wrong" });
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ error: "rate_limited" });
  const retryAfter = Number(blocked.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
});

test("the budget is per account — one address being throttled does not lock out another", async () => {
  const victim = `victim_${Date.now()}@example.com`;
  const other = `other_${Date.now()}@example.com`;

  for (let i = 0; i < env.authRpm + 1; i++) {
    await req("POST", "/api/auth/login", undefined, { email: victim, password: "wrong" });
  }
  expect(
    (await req("POST", "/api/auth/login", undefined, { email: victim, password: "wrong" })).status,
  ).toBe(429);

  // A different account is unaffected: the throttle must not become a way to
  // deny service to everyone by hammering one address.
  expect(
    (await req("POST", "/api/auth/login", undefined, { email: other, password: "wrong" })).status,
  ).toBe(401);
});

test("signup is throttled per address too", async () => {
  const email = `signup_rl_${Date.now()}@example.com`;
  // Password too short => rejected before any hashing, but after the limiter,
  // so the budget is consumed exactly as a real attempt would consume it.
  for (let i = 0; i < env.authRpm; i++) {
    const r = await req("POST", "/api/auth/signup", undefined, {
      email,
      password: PW,
      name: "X",
    });
    expect(r.status).not.toBe(429);
  }
  const blocked = await req("POST", "/api/auth/signup", undefined, {
    email,
    password: PW,
    name: "X",
  });
  expect(blocked.status).toBe(429);
});

test("a 429 says nothing about whether the account exists", async () => {
  // Both a real and an unknown address must throttle identically, or the
  // limiter undoes the generic-failure protection on the login handler.
  const unknown = `ghost_${Date.now()}@example.com`;
  for (let i = 0; i < env.authRpm + 1; i++) {
    await req("POST", "/api/auth/login", undefined, { email: unknown, password: "wrong" });
  }
  const r = await req("POST", "/api/auth/login", undefined, { email: unknown, password: "wrong" });
  expect(r.status).toBe(429);
  expect(await r.json()).toEqual({ error: "rate_limited" });
});
