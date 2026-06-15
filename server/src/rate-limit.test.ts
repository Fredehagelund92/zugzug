process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { pgRun } from "./pg.ts";
import { checkRateLimit } from "./rate-limit.ts";

const CRED = "sa_test_rate_limit";

beforeAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."auth_credential_quota" WHERE credential_id = $1`, [
    CRED,
  ]).catch(() => {});
});

beforeEach(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."auth_credential_quota" WHERE credential_id = $1`, [CRED]);
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."auth_credential_quota" WHERE credential_id = $1`, [CRED]);
});

describe("checkRateLimit — fixed-window counter", () => {
  it("first request within budget returns ok", async () => {
    const r = await checkRateLimit(CRED, 5);
    expect(r.ok).toBe(true);
  });

  it("budget-th request still ok, budget+1 returns 429 with retryAfter", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(CRED, 5);
      expect(r.ok).toBe(true);
    }
    const r6 = await checkRateLimit(CRED, 5);
    expect(r6.ok).toBe(false);
    if (!r6.ok) {
      expect(r6.retryAfterSeconds).toBeGreaterThan(0);
      expect(r6.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("budget of 0 disables the limiter", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit(CRED, 0);
      expect(r.ok).toBe(true);
    }
  });

  it("window rolls over when persisted window_started_at is >60s old", async () => {
    await checkRateLimit(CRED, 1); // count=1, fills the budget
    expect((await checkRateLimit(CRED, 1)).ok).toBe(false);
    // Rewind the window to 65s ago.
    await pgRun(
      `UPDATE "zugzug_app"."auth_credential_quota"
          SET window_started_at = now() - interval '65 seconds'
        WHERE credential_id = $1`,
      [CRED],
    );
    const r = await checkRateLimit(CRED, 1);
    expect(r.ok).toBe(true); // window rolled, count reset
  });
});
