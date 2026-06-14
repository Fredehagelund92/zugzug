process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.MOTHERDUCK_TOKEN = "md_test";
process.env.WAREHOUSE_DB = "analytics";
process.env.ATTACH_WAREHOUSE = "false";
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import {
  createWarehouseConnection,
  addWarehouseDatabase,
} from "../src/repo-warehouse.ts";

const T = `twh_${process.pid}`;
const ADMIN = `u_admin_${process.pid}`;

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."active_sessions" WHERE user_id = $1`, [ADMIN]);
  await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [ADMIN]);
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]);
}
beforeEach(cleanup);

async function setupWithConnection(): Promise<{ cookie: string; tenantSlug: string; connId: string; dbId: string }> {
  await provisionTenant({ id: T, label: "Whouse" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, is_super_admin)
     VALUES ($1, $2, $3, true)`,
    [ADMIN, `Admin ${ADMIN}`, "A"],
  );
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const conn = await createWarehouseConnection({
    tenantId: T,
    adapter: "motherduck",
    label: "Prod",
    credentials: { type: "duckdb", token: "md_x", writable: false },
    actorUserId: ADMIN,
  });
  const wd = await addWarehouseDatabase({
    tenantId: T,
    connectionId: conn.id,
    databaseName: "analytics",
    actorUserId: ADMIN,
  });
  return { cookie: `zz_sid=${sid}`, tenantSlug: T, connId: conn.id, dbId: wd.id };
}

test("GET /api/t/:slug/warehouse/connection returns the projection (no credentials)", async () => {
  const { cookie, tenantSlug, connId } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    id: string;
    adapter: string;
    credentialsVersion: number;
    credentials?: unknown;
  };
  expect(body.id).toBe(connId);
  expect(body.adapter).toBe("motherduck");
  expect(body.credentialsVersion).toBe(1);
  expect(body).not.toHaveProperty("credentials");
});

test("GET /api/t/:slug/warehouse/connection returns null when none configured", async () => {
  await provisionTenant({ id: T, label: "Empty" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, is_super_admin)
     VALUES ($1, $2, $3, true)`,
    [ADMIN, `Admin ${ADMIN}`, "A"],
  );
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${T}/warehouse/connection`, {
      headers: { cookie: `zz_sid=${sid}` },
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toBeNull();
});

test("GET /api/t/:slug/warehouse/databases returns the list with sourceCount=0", async () => {
  const { cookie, tenantSlug, dbId } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases`, {
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{
    id: string;
    databaseName: string;
    sourceCount: number;
  }>;
  expect(body.length).toBe(1);
  expect(body[0].id).toBe(dbId);
  expect(body[0].databaseName).toBe("analytics");
  expect(body[0].sourceCount).toBe(0);
});
