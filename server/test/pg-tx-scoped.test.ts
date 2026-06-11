process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { pgTxScoped } from "../src/pg.ts";

test("pgTxScoped exposes app.tenant_id via current_setting inside the tx", async () => {
  const seen = await pgTxScoped("default", async (tx) => {
    const row = await tx.get<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`);
    return row?.t;
  });
  expect(seen).toBe("default");
});

test("pgTxScoped isolates settings between transactions (SET LOCAL semantics)", async () => {
  const a = await pgTxScoped("tprov_a_setting", async (tx) =>
    (await tx.get<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`))?.t,
  );
  const b = await pgTxScoped("tprov_b_setting", async (tx) =>
    (await tx.get<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`))?.t,
  );
  expect(a).toBe("tprov_a_setting");
  expect(b).toBe("tprov_b_setting");
});

test("pgTxScoped rolls back if fn throws", async () => {
  // Use audit_log as a scratch table — we can roll back an INSERT cleanly.
  const probeId = `probe_${Date.now()}`;
  let thrown: Error | null = null;
  try {
    await pgTxScoped("default", async (tx) => {
      await tx.run(
        `INSERT INTO "zugzug_app"."audit_log" (id, created_at, user_id, action, detail)
         VALUES ($1, now(), 'u_test', 'probe', 'rollback-test')`,
        [probeId],
      );
      throw new Error("rollback me");
    });
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown?.message).toBe("rollback me");

  // Re-check outside the tx — row must not exist.
  const { pgGet } = await import("../src/pg.ts");
  const row = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."audit_log" WHERE id = $1`,
    [probeId],
  );
  expect(row).toBeNull();
});

test("pgTxScoped rejects invalid tenant id (defense-in-depth)", async () => {
  let thrown: Error | null = null;
  try {
    await pgTxScoped("' OR 1=1 --", async () => "noop");
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
});
