process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { getAiHint } from "../src/repo-ai-hint.ts";
import { env } from "../src/env.ts";

const TA = "tah_a";
const TB = "tah_b";
const DIM = "tah_dim";
const RAW = "FRA_IS_NOT_A_REAL_CANONICAL_LABEL";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."ai_hint_cache" WHERE dim_id = $1`, [DIM]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("getAiHint cache lookup is scoped by tenant_id", async () => {
  // Seed a deterministic cache row for tenant A only
  await pgRun(
    `INSERT INTO "zugzug_app"."ai_hint_cache"
       (dim_id, raw, suggestion, confidence, reasoning, model, created_at, hits, tenant_id)
     VALUES ($1, $2, 'France', 95, 'seeded by test', 'test-model', current_timestamp, 0, $3)`,
    [DIM, RAW, TA],
  );

  // Tenant A: cache hit returning the seeded row.
  const a = await getAiHint(DIM, RAW, ["France", "Germany"], { label: "Country" }, TA);
  expect(a.cached).toBe(true);
  expect(a.suggestion).toBe("France");
  expect(a.reasoning).toBe("seeded by test");

  // Tenant B: lookup must NOT find tenant A's row. The function then either calls
  // the LLM (when ANTHROPIC_API_KEY is set) or short-circuits (when unset). In
  // either branch, `cached` is false — that's the property we're asserting.
  if (!env.anthropicApiKey) {
    const b = await getAiHint(DIM, RAW, ["France", "Germany"], { label: "Country" }, TB);
    expect(b.cached).toBe(false);
    expect(b.suggestion).toBeNull();
  } else {
    // With an LLM available, pass an EMPTY canonical list so the function takes
    // the path that returns early without a real API hit (path #2 in getAiHint).
    const b = await getAiHint(DIM, RAW, [], { label: "Country" }, TB);
    expect(b.cached).toBe(false);
    expect(b.suggestion).toBeNull();
    expect(b.reasoning).toContain("No canonical");
  }
});
