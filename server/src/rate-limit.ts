/* rate-limit.ts — per-credential fixed-window rate limiter.

   Budget is the maximum number of requests allowed per 1-minute window.
   Budget 0 disables the limiter entirely (caller passes 0 when
   ZUGZUG_PULL_API_RPM=0). The counter is persisted in
   auth_credential_quota so a server restart mid-minute doesn't reset
   it. Per-credential UPSERT is atomic — concurrent requests from the
   same credential race-safely. */

import { pg } from "./env.ts";
import { pgGet } from "./pg.ts";

const WINDOW_SECONDS = 60;

export type RateLimitResult =
  | { ok: true; count: number; budget: number }
  | { ok: false; retryAfterSeconds: number; budget: number };

/** Atomically increment the count for `credentialId` within the current
 *  1-minute window. If the persisted window is older than WINDOW_SECONDS
 *  the row is rolled (window_started_at = now(), count = 1). When the
 *  budget is 0, this is a no-op that always returns ok. */
export async function checkRateLimit(
  credentialId: string,
  budget: number,
): Promise<RateLimitResult> {
  if (budget <= 0) return { ok: true, count: 0, budget: 0 };

  // INSERT … ON CONFLICT … RETURNING. Inside ON CONFLICT, the
  // unqualified `auth_credential_quota` references the existing row;
  // Postgres scopes it correctly. (The schema-qualified form upset
  // Postgres in some configurations — see Task 9 notes.)
  const row = await pgGet<{ count: number; window_age_seconds: number }>(
    `INSERT INTO ${pg("auth_credential_quota")}
       (credential_id, window_started_at, count)
       VALUES ($1, now(), 1)
       ON CONFLICT (credential_id) DO UPDATE
         SET window_started_at = CASE
               WHEN auth_credential_quota.window_started_at < now() - interval '${WINDOW_SECONDS} seconds'
               THEN now()
               ELSE auth_credential_quota.window_started_at
             END,
             count = CASE
               WHEN auth_credential_quota.window_started_at < now() - interval '${WINDOW_SECONDS} seconds'
               THEN 1
               ELSE auth_credential_quota.count + 1
             END
       RETURNING count, extract(epoch FROM (now() - window_started_at))::int AS window_age_seconds`,
    [credentialId],
  );

  if (!row) {
    // Shouldn't happen; INSERT … ON CONFLICT … RETURNING always returns.
    return { ok: true, count: 0, budget };
  }

  if (row.count <= budget) {
    return { ok: true, count: row.count, budget };
  }
  const retryAfter = Math.max(1, WINDOW_SECONDS - row.window_age_seconds);
  return { ok: false, retryAfterSeconds: retryAfter, budget };
}
