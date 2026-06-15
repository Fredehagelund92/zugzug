import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import { handleCreateToken, getApiTokenUser } from "./auth-api-tokens.ts";

const U = "u_test_tp";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'TP User', 'tp@example.test', 'TP', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."api_tokens" WHERE user_id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
});

describe("api_tokens.token_prefix", () => {
  it("handleCreateToken populates token_prefix with the first 12 chars of the value", async () => {
    const req = new Request("http://test/api/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "dbt prod" }),
    });
    const res = await handleCreateToken(req, U);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; value: string };
    expect(body.value.startsWith("zz_")).toBe(true);
    const row = await pgGet<{ token_prefix: string | null }>(
      `SELECT token_prefix FROM "zugzug_app"."api_tokens" WHERE id = $1`,
      [body.id],
    );
    expect(row).not.toBeNull();
    expect(row!.token_prefix).toBe(body.value.slice(0, 12));
  });

  it("getApiTokenUser authenticates a newly-created token via the fast path", async () => {
    const req = new Request("http://test/api/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "ci builder" }),
    });
    const res = await handleCreateToken(req, U);
    const { value } = (await res.json()) as { value: string };

    const authReq = new Request("http://test/api/anything", {
      headers: { authorization: `Bearer ${value}` },
    });
    const user = await getApiTokenUser(authReq);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(U);
  });
});
