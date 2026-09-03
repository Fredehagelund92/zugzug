process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { pgGet } from "../src/pg.ts";
import { registerFactories } from "../src/warehouse/credentials.ts";
import { _resetAdapterCache } from "../src/warehouse/registry.ts";
import { createDuckDbAdapter, DuckDbWritableAdapter } from "../src/warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "../src/warehouse/snowflake/index.ts";
import type {
  WritableWarehouseAdapter,
  AdapterCapabilities,
  ApprovedDraft,
  RefTableSpec,
  CommitResult,
} from "../src/warehouse/adapter.ts";

beforeEach(async () => {
  await resetDb();
  _resetAdapterCache();
});

// A minimal in-test WritableWarehouseAdapter that captures commit calls.
function makeWritableMock(opts: { failCommit?: boolean } = {}) {
  const ensured: RefTableSpec[] = [];
  const committed: { refTable: RefTableSpec; drafts: ApprovedDraft[] }[] = [];
  const adapter: Partial<WritableWarehouseAdapter> = {
    capabilities: {
      id: "snowflake",
      writable: true,
      supportsMerge: true,
      identifierCase: "upper",
      supportsApproximateDistinct: true,
    } as AdapterCapabilities & { readonly writable: true },
    async ping() {
      return true;
    },
    async ensureRecordTables(d: RefTableSpec) {
      ensured.push(d);
    },
    async commitRecord(d: RefTableSpec, drafts: ApprovedDraft[]): Promise<CommitResult> {
      if (opts.failCommit) throw new Error("simulated warehouse failure");
      committed.push({ refTable: d, drafts });
      return { rowsWritten: drafts.length };
    },
  };
  return { adapter: adapter as WritableWarehouseAdapter, ensured, committed };
}

test("commit in postgres-export mode (DuckDB read-only): warehouseSynced=n/a; no adapter writes", async () => {
  const refTableId = await repo.addRefTable(
    "Country",
    [],
    { keyKind: "slug" },
    "u_test",
    "default",
  );
  await repo.saveDraft(refTableId, "USA", "mapped", "United States", "us", "u_test", "default");
  const result = await repo.commit(refTableId, "u_test", "default");
  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("n/a");
});

test("commit in writable mode (success): warehouseSynced=synced; audit event emitted", async () => {
  const { adapter, ensured, committed } = makeWritableMock();
  registerFactories({
    duckdb: async () => adapter,
    snowflake: async () => adapter,
  });
  _resetAdapterCache();

  const refTableId = await repo.addRefTable(
    "Country",
    [],
    { keyKind: "slug" },
    "u_test",
    "default",
  );
  await repo.saveDraft(refTableId, "USA", "mapped", "United States", "us", "u_test", "default");
  const result = await repo.commit(refTableId, "u_test", "default");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("synced");
  expect(ensured).toHaveLength(1);
  expect(committed).toHaveLength(1);
  expect(committed[0].drafts).toContainEqual({
    raw: "USA",
    key: "us",
    label: "United States",
  });

  const audits = await repo.listAudit(10);
  expect(audits.some((a) => a.action === "Warehouse synced")).toBe(true);
});

test("commit in writable mode (warehouse fails): Postgres committed; warehouseSynced=failed; failure audit event", async () => {
  const { adapter } = makeWritableMock({ failCommit: true });
  registerFactories({
    duckdb: async () => adapter,
    snowflake: async () => adapter,
  });
  _resetAdapterCache();

  const refTableId = await repo.addRefTable(
    "Country",
    [],
    { keyKind: "slug" },
    "u_test",
    "default",
  );
  await repo.saveDraft(refTableId, "USA", "mapped", "United States", "us", "u_test", "default");
  const result = await repo.commit(refTableId, "u_test", "default");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("failed");

  // Postgres record SHOULD reflect the commit (drafts cleared, refTable/map rows present, "default").
  const drafts = await repo.listDrafts(refTableId, "default");
  expect(drafts).toHaveLength(0);

  const refTable = await repo.getRefTable(refTableId, "default");
  expect(refTable?.record.some((c) => c.key === "us")).toBe(true);

  const audits = await repo.listAudit(10);
  const failAudit = audits.find((a) => a.action === "Warehouse sync failed");
  expect(failAudit).toBeDefined();
  expect(failAudit?.detail).toContain("simulated warehouse failure");
});

test("commit with no approved drafts: returns early; no warehouse call attempted", async () => {
  const { adapter, ensured, committed } = makeWritableMock();
  registerFactories({
    duckdb: async () => adapter,
    snowflake: async () => adapter,
  });
  _resetAdapterCache();

  const refTableId = await repo.addRefTable(
    "Country",
    [],
    { keyKind: "slug" },
    "u_test",
    "default",
  );
  // No drafts saved.
  const result = await repo.commit(refTableId, "u_test", "default");
  expect(result.committed).toBe(0);
  expect(result.warehouseSynced).toBe("n/a"); // nothing to sync
  expect(ensured).toHaveLength(0);
  expect(committed).toHaveLength(0);
});

test("commit in writable DuckDB mode: rows land in MERGE-target tables end-to-end", async () => {
  // A real DuckDbWritableAdapter against :memory:. The Postgres record mirror
  // also exists (via the normal pgTx path) — we're verifying both sides happen.
  const writableDuckDb = new DuckDbWritableAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "memory",
    attached: false,
    writable: true,
  });

  // Pre-create the schema so ensureRecordTables can target it
  // @ts-expect-error — protected connect()
  const c = await writableDuckDb["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);

  // Swap factories to return our writable DuckDB adapter for both types.
  registerFactories({
    duckdb: async () => writableDuckDb,
    snowflake: async () => writableDuckDb, // doesn't matter; test only triggers duckdb
  });
  _resetAdapterCache();

  const refTableId = await repo.addRefTable(
    "Country",
    [],
    { keyKind: "slug" },
    "u_test",
    "default",
  );
  await repo.saveDraft(refTableId, "USA", "mapped", "United States", "us", "u_test", "default");

  const result = await repo.commit(refTableId, "u_test", "default");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("synced");

  // Verify the writable DuckDB actually has the rows in its dim_/map_ tables.
  // Note: addRefTable creates the refTable under the env.recordSchema ("zugzug").
  const refTableRows = await c.runAndReadAll(`SELECT * FROM zugzug.dim_country ORDER BY 1`);
  expect(refTableRows.getRowObjects()).toEqual([{ country_code: "us", label: "United States" }]);
  const mapRows = await c.runAndReadAll(`SELECT * FROM zugzug.map_country ORDER BY raw`);
  expect(mapRows.getRowObjects()).toEqual([{ raw: "USA", country_code: "us" }]);

  // Audit log captures the sync
  const audits = await repo.listAudit(10);
  expect(audits.some((a) => a.action === "Warehouse synced")).toBe(true);
});

test("writable DuckDB publish: schema auto-created; re-map, rename and retire follow through", async () => {
  // No CREATE SCHEMA here on purpose — ensureRecordTables has to provision it,
  // which is what a first publish against a fresh warehouse actually hits.
  const wh = new DuckDbWritableAdapter({
    type: "duckdb",
    path: ":memory:",
    attached: false,
    writable: true,
  });
  registerFactories({ duckdb: async () => wh, snowflake: async () => wh });
  _resetAdapterCache();

  const refTableId = await repo.addRefTable(
    "Country",
    [],
    { keyKind: "slug" },
    "u_test",
    "default",
  );
  await repo.saveDraft(refTableId, "USA", "mapped", "United States", "us", "u_test", "default");
  expect((await repo.commit(refTableId, "u_test", "default")).warehouseSynced).toBe("synced");

  // @ts-expect-error — protected connect()
  const c = await wh["connect"]();
  const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjects();
  const version = async (key: string) =>
    Number(
      (
        await pgGet<{ v: number }>(
          `SELECT version AS v FROM "zugzug_app"."record_version"
            WHERE reference_table_id = $1 AND key = $2 AND tenant_id = 'default'`,
          [refTableId, key],
        )
      )?.v ?? 1,
    );

  expect(await rows(`SELECT * FROM zugzug.map_country ORDER BY raw`)).toEqual([
    { raw: "USA", country_code: "us" },
  ]);

  // Re-map the same source value to a different record: the existing map row
  // must move, not gain a duplicate.
  await repo.saveDraft(
    refTableId,
    "USA",
    "mapped",
    "United States of America",
    "usa",
    "u_test",
    "default",
  );
  await repo.commit(refTableId, "u_test", "default");
  expect(await rows(`SELECT * FROM zugzug.map_country ORDER BY raw`)).toEqual([
    { raw: "USA", country_code: "usa" },
  ]);

  // Rename a record — no draft of its own, so only the record-edit path carries it.
  await repo.renameRecord(refTableId, "usa", "USA", "u_test", await version("usa"), "default");
  await repo.commit(refTableId, "u_test", "default");
  expect(await rows(`SELECT label FROM zugzug.dim_country WHERE country_code = 'usa'`)).toEqual([
    { label: "USA" },
  ]);

  // Retire the record the value used to point at — its published row must go.
  await repo.retireRecord(refTableId, "us", "u_test", await version("us"), "default");
  await repo.commit(refTableId, "u_test", "default");
  expect(await rows(`SELECT country_code FROM zugzug.dim_country ORDER BY 1`)).toEqual([
    { country_code: "usa" },
  ]);
});

test("writable DuckDB publish: a record merge re-points the published map rows", async () => {
  const wh = new DuckDbWritableAdapter({
    type: "duckdb",
    path: ":memory:",
    attached: false,
    writable: true,
  });
  registerFactories({ duckdb: async () => wh, snowflake: async () => wh });
  _resetAdapterCache();

  const refTableId = await repo.addRefTable(
    "Country",
    [],
    { keyKind: "slug" },
    "u_test",
    "default",
  );
  await repo.addRecordOne(refTableId, "US", undefined, "u_test", "default");
  await repo.addRecordOne(refTableId, "USA", undefined, "u_test", "default");
  await repo.saveDraft(refTableId, "U.S.", "mapped", "US", "us", "u_test", "default");
  await repo.saveDraft(refTableId, "U.S.A.", "mapped", "USA", "usa", "u_test", "default");
  await repo.commit(refTableId, "u_test", "default");

  // @ts-expect-error — protected connect()
  const c = await wh["connect"]();
  const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjects();

  // Fold "usa" into "us": Postgres re-points U.S.A. and drops the loser row.
  await repo.mergeRecord(refTableId, "us", ["usa"], "u_test", { us: 1, usa: 1 }, "default");
  await repo.commit(refTableId, "u_test", "default");

  // The published map has to follow — the variant must not vanish with the key
  // it was merged away from.
  expect(await rows(`SELECT * FROM zugzug.map_country ORDER BY raw`)).toEqual([
    { raw: "U.S.", country_code: "us" },
    { raw: "U.S.A.", country_code: "us" },
  ]);
  expect(await rows(`SELECT country_code FROM zugzug.dim_country ORDER BY 1`)).toEqual([
    { country_code: "us" },
  ]);
});

// Cleanup: restore real factories at end of file so subsequent test files see DuckDB
afterAll(async () => {
  registerFactories({
    duckdb: async (creds) => createDuckDbAdapter(creds),
    snowflake: async (creds) => new SnowflakeAdapter(creds),
  });
  _resetAdapterCache();
});
