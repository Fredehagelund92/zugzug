// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgAll, pgGet, pgRun } from "../src/pg.ts";
import { makeMember, makeUser, makeWorkspace, req } from "./factories/index.ts";
import { addRefTable, addRecordOne, deleteRefTable, removeSource } from "../src/repo-record.ts";
import { deriveRecord, listSources } from "../src/repo-scan.ts";

/* Wiring a column browsed in the SECOND registered database used to land in the
   FIRST one (resolveDefaultDatabase), so every later scan read the wrong
   warehouse — and re-scanning an already-correct source inserted a duplicate
   registration under the default database. */

const T = "tsdb_ident";
const U = "u_sdb_ident";
const DB1 = "wdb_ident_one";
const DB2 = "wdb_ident_two";

async function cleanup(): Promise<void> {
  const refTables = await pgAll<{ id: string }>(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  ).catch(() => [] as { id: string }[]);
  for (const d of refTables) await deleteRefTable(d.id, "test-teardown", T).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."source_stat" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE id = ANY($1::text[])`, [
    [DB1, DB2],
  ]);
}

/** A refTable that already holds a record, so deriveRecord takes the "connect"
 *  path and never needs a live warehouse. */
async function wiredRefTable(): Promise<string> {
  const id = await addRefTable("Region", [], { keyKind: "slug" }, U, T);
  await addRecordOne(id, "Europe", undefined, U, T);
  return id;
}

async function registrations(refTableId: string): Promise<{ db: string; column: string }[]> {
  return pgAll<{ db: string; column: string }>(
    `SELECT database_id AS db, column_name AS column
       FROM "zugzug_app"."reference_table_source"
      WHERE tenant_id = $1 AND reference_table_id = $2
      ORDER BY database_id, column_name`,
    [T, refTableId],
  );
}

beforeEach(async () => {
  await cleanup();
  await makeUser(U);
  await makeWorkspace(T);
  // DB1 is registered first, so it is what resolveDefaultDatabase() picks.
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database" (id, database_name, added_at, added_by)
     VALUES ($1, 'analytics_one', now() - interval '1 day', $3),
            ($2, 'analytics_two', now(), $3)`,
    [DB1, DB2, U],
  );
});
afterAll(cleanup);

test("wiring a column browsed in the second database registers it there", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB2 }, U, T);
  expect(await registrations(refTableId)).toEqual([{ db: DB2, column: "region" }]);
});

test("without a database the wiring still falls back to the default one", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, {}, U, T);
  expect(await registrations(refTableId)).toEqual([{ db: DB1, column: "region" }]);
});

test("re-scanning an existing source adds no duplicate under the default database", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB2 }, U, T);
  // The Sources / table-pane "Re-scan" path sends no database at all.
  await deriveRecord(refTableId, "sales.orders", "region", undefined, {}, U, T);
  expect(await registrations(refTableId)).toEqual([{ db: DB2, column: "region" }]);
});

test("listSources carries the database identity of each wiring", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB2 }, U, T);
  const [row] = await listSources({ tenantId: T });
  expect(row).toMatchObject({
    databaseId: DB2,
    databaseName: "analytics_two",
    table: "sales.orders",
    column: "region",
  });
});

test("the scan of a second-database source reads that database's catalog", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB2 }, U, T);
  const stat = await pgGet<{ db: string }>(
    `SELECT database_id AS db FROM "zugzug_app"."source_stat"
      WHERE tenant_id = $1 AND reference_table_id = $2`,
    [T, refTableId],
  );
  expect(stat?.db).toBe(DB2);
});

test("removeSource reports whether it actually removed anything", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB2 }, U, T);
  const src = {
    databaseId: DB2,
    schemaName: "sales",
    tableName: "orders",
    columnName: "region",
  };
  expect(await removeSource(refTableId, src, T)).toBe(true);
  expect(await removeSource(refTableId, src, T)).toBe(false);
});

test("DELETE /tables/:id/sources says when the wiring it was given matched nothing", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB2 }, U, T);
  const { cookie } = await makeMember(U, T, "admin");
  const body = (databaseId: string) => ({
    source: { databaseId, schemaName: "sales", tableName: "orders", columnName: "region" },
  });

  // The default database holds no such wiring — this must not claim a removal.
  const wrong = await req("DELETE", `/api/t/${T}/tables/${refTableId}/sources`, cookie, body(DB1));
  expect(wrong.status).toBe(200);
  expect(await wrong.json()).toEqual({ removed: false });
  expect((await registrations(refTableId)).length).toBe(1);

  const right = await req("DELETE", `/api/t/${T}/tables/${refTableId}/sources`, cookie, body(DB2));
  expect(await right.json()).toEqual({ removed: true });
  expect(await registrations(refTableId)).toEqual([]);
});

/* refForRegisteredTable backs nameTable and topUnmapped. Its lookup had a bare
   LIMIT 1 with no ORDER BY, so when the same schema.table was registered against
   two databases the row Postgres happened to return decided which warehouse was
   read — the same ambiguity the wiring fix above closes everywhere else. */

test("resolving a registered table honours the database it is given", async () => {
  const refTableId = await wiredRefTable();
  // The same schema.table wired in BOTH databases: ambiguous without a hint.
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB1 }, U, T);
  await deriveRecord(refTableId, "sales.orders", "country", undefined, { databaseId: DB2 }, U, T);

  const { refForRegisteredTable } = await import("../src/repo-shared.ts");
  expect(await refForRegisteredTable(refTableId, "sales.orders", T, DB2)).toEqual({
    catalog: "analytics_two",
    schema: "sales",
    table: "orders",
  });
  expect(await refForRegisteredTable(refTableId, "sales.orders", T, DB1)).toEqual({
    catalog: "analytics_one",
    schema: "sales",
    table: "orders",
  });
});

test("resolving without a database is stable rather than arbitrary", async () => {
  const refTableId = await wiredRefTable();
  await deriveRecord(refTableId, "sales.orders", "region", undefined, { databaseId: DB1 }, U, T);
  await deriveRecord(refTableId, "sales.orders", "country", undefined, { databaseId: DB2 }, U, T);

  const { refForRegisteredTable } = await import("../src/repo-shared.ts");
  const first = await refForRegisteredTable(refTableId, "sales.orders", T);
  for (let i = 0; i < 5; i++) {
    expect(await refForRegisteredTable(refTableId, "sales.orders", T)).toEqual(first);
  }
});
