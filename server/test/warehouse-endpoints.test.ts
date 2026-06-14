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
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
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

test("POST /warehouse/connection encrypts the credentials and returns the projection", async () => {
  await provisionTenant({ id: T, label: "WriteTest" });
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
      method: "POST",
      headers: { cookie: `zz_sid=${sid}`, "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "motherduck",
        label: "MyProd",
        credentials: { type: "duckdb", token: "md_user_token", writable: false },
      }),
    }),
    () => {},
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.adapter).toBe("motherduck");
  expect(body).not.toHaveProperty("credentials");
});

test("PATCH /warehouse/connection 412 on stale If-Match", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "If-Match": "99" },
      body: JSON.stringify({ label: "Renamed" }),
    }),
    () => {},
  );
  expect(res.status).toBe(412);
  const body = await res.json();
  expect(body.kind).toBe("STALE_VERSION");
  expect(body.currentVersion).toBe(1);
});

test("PATCH /warehouse/connection with same credentials does not bump version", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ credentials: { type: "duckdb", token: "md_x", writable: false } }),
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.credentialsVersion).toBe(1);
});

test("DELETE /warehouse/connection returns 409 while databases exist", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "DELETE",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.kind).toBe("CONNECTION_IN_USE");
  expect(body.databaseCount).toBe(1);
});

test("POST /warehouse/databases rejects invalid identifier", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ databaseName: "bad'name" }),
    }),
    () => {},
  );
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.kind).toBe("INVALID_IDENTIFIER");
});

test("DELETE /warehouse/databases/:id returns 409 when sources exist (no force)", async () => {
  const { cookie, tenantSlug, dbId } = await setupWithConnection();
  // dimension_source has no FK to `dimension` — insert directly with a synthetic dim_id.
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension_source"
       (tenant_id, dim_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, 'public', 'orders', 'country')`,
    [T, "dim_test_t14", dbId],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases/${dbId}`, {
      method: "DELETE",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.kind).toBe("DATABASE_IN_USE");
  expect(body.sourceCount).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(body.dimensions)).toBe(true);
  expect(body.dimensions[0]?.dimId).toBe("dim_test_t14");
  expect(body.dimensions[0]?.sources).toContain("public.orders.country");
});
