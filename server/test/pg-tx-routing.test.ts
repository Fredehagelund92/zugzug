process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgAll, pgGet, pgRun, pgTxScoped, pgContext } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_IDS = ["t_txroute_e2e"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("pgTxScoped sets app.tenant_id and pgGet inside reads it via current_setting", async () => {
  await provisionTenant({ id: "t_txroute_e2e", slug: "t_txroute", label: "TxRoute", warehouseId: "default" });
  await pgTxScoped("t_txroute_e2e", async () => {
    const row = await pgGet<{ v: string }>(
      `SELECT current_setting('app.tenant_id') AS v`,
      [],
    );
    expect(row?.v).toBe("t_txroute_e2e");
  });
});

test("pgGet outside pgTxScoped uses the pool (no app.tenant_id)", async () => {
  const row = await pgGet<{ v: string | null }>(
    `SELECT current_setting('app.tenant_id', true) AS v`,
    [],
  );
  // Postgres returns '' (empty string) when missing_ok=true and the GUC is unset
  expect(row?.v ?? "").toBe("");
});

test("pgContext.tx is populated inside pgTxScoped", async () => {
  await provisionTenant({ id: "t_txroute_e2e", slug: "t_txroute", label: "TxRoute", warehouseId: "default" });
  let observedTx: unknown = null;
  await pgTxScoped("t_txroute_e2e", async () => {
    observedTx = pgContext.getStore()?.tx;
  });
  expect(observedTx).not.toBeNull();
});
