import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { pg } from "../src/env.ts";
import { getAiHint } from "../src/repo-ai-hint.ts";
import { resolveAIConfig, isAIConfigured } from "../src/suggestion.ts";
import { provisionTenant } from "../src/tenant.ts";

/* Whether AI is available is a per-workspace question, and the answer decides
 * whether Review renders "Suggest with AI" at all. A workspace that switched AI
 * on but never supplied a key must read as "not configured" rather than blowing
 * up the status endpoint. */

const T = "aicfg_t";
const REF_TABLE = "aicfg_dim";

beforeAll(async () => {
  await provisionTenant({ id: T, label: "AI Config Tenant" });
});

afterEach(async () => {
  await pgRun(`DELETE FROM ${pg("preferences")} WHERE id = $1`, [PREFS_ID]);
  await pgRun(`DELETE FROM ${pg("ai_hint_cache")} WHERE reference_table_id = $1`, [REF_TABLE]);
});

afterAll(async () => {
  await pgRun(`DELETE FROM ${pg("tenant")} WHERE id = $1`, [T]);
});

// The id is explicit: other suites insert preferences with a literal id, which
// leaves the serial sequence behind and makes the default collide.
const PREFS_ID = 9101;

async function setPrefs(enabled: boolean, provider: string, key: string | null): Promise<void> {
  await pgRun(
    `INSERT INTO ${pg("preferences")}
       (id, publish_threshold, suggest_threshold, updated_at, tenant_id, ai_enabled, ai_provider, ai_api_key)
     VALUES ($1, 90, 60, current_timestamp, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET tenant_id   = EXCLUDED.tenant_id,
           ai_enabled  = EXCLUDED.ai_enabled,
           ai_provider = EXCLUDED.ai_provider,
           ai_api_key  = EXCLUDED.ai_api_key`,
    [PREFS_ID, T, enabled, provider, key],
  );
}

test("a workspace's own key resolves to its provider", async () => {
  await setPrefs(true, "anthropic", "sk-workspace-key");
  expect(await resolveAIConfig(T)).toEqual({
    provider: "anthropic",
    apiKey: "sk-workspace-key",
  });
  expect(await isAIConfigured(T)).toBe(true);
});

test("an openai workspace resolves to openai", async () => {
  await setPrefs(true, "openai", "sk-workspace-key");
  expect((await resolveAIConfig(T))?.provider).toBe("openai");
});

test("AI switched on with no key reads as not configured instead of throwing", async () => {
  await setPrefs(true, "openai", null);
  await expect(resolveAIConfig(T)).rejects.toThrow(/API key is not configured/);
  expect(await isAIConfigured(T)).toBe(false);
});

test("getAiHint says so when the table has no records to match against", async () => {
  const hint = await getAiHint(REF_TABLE, "FRA", [], { label: "Country" }, T);
  expect(hint.suggestion).toBeNull();
  expect(hint.reasoning).toBe("No records exist in this table yet.");
});

test("getAiHint drops a cached suggestion that is no longer a record in the table", async () => {
  // The record was renamed or removed after the hint was cached; returning it
  // would offer a mapping target that doesn't exist.
  await pgRun(
    `INSERT INTO ${pg("ai_hint_cache")}
       (reference_table_id, raw, suggestion, confidence, reasoning, model, created_at, hits, tenant_id)
     VALUES ($1, $2, 'Atlantis', 95, 'seeded by test', 'test-model', current_timestamp, 0, $3)`,
    [REF_TABLE, "ATL", T],
  );
  const hint = await getAiHint(REF_TABLE, "ATL", ["France", "Germany"], { label: "Country" }, T);
  expect(hint.suggestion).toBeNull();
  expect(hint.reasoning).toBe("No match in this table.");
  expect(hint.cached).toBe(true);
});
