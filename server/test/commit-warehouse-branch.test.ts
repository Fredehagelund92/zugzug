process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { registerFactories } from "../src/warehouse/credentials.ts";
import { _resetAdapterCache } from "../src/warehouse/registry.ts";
import { createDuckDbAdapter, DuckDbWritableAdapter } from "../src/warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "../src/warehouse/snowflake/index.ts";
import type {
  WritableWarehouseAdapter,
  AdapterCapabilities,
  ApprovedDraft,
  DimensionSpec,
  CommitResult,
} from "../src/warehouse/adapter.ts";

beforeEach(async () => {
  await resetDb();
  _resetAdapterCache();
});

// A minimal in-test WritableWarehouseAdapter that captures commit calls.
function makeWritableMock(opts: { failCommit?: boolean } = {}) {
  const ensured: DimensionSpec[] = [];
  const committed: { dim: DimensionSpec; drafts: ApprovedDraft[] }[] = [];
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
    async ensureCanonicalTables(d: DimensionSpec) {
      ensured.push(d);
    },
    async commitCanonical(d: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult> {
      if (opts.failCommit) throw new Error("simulated warehouse failure");
      committed.push({ dim: d, drafts });
      return { rowsWritten: drafts.length };
    },
  };
  return { adapter: adapter as WritableWarehouseAdapter, ensured, committed };
}

test("commit in postgres-export mode (DuckDB read-only): warehouseSynced=n/a; no adapter writes", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");
  const result = await repo.commit(dimId, "u_test");
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

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");
  const result = await repo.commit(dimId, "u_test");

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

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");
  const result = await repo.commit(dimId, "u_test");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("failed");

  // Postgres canonical SHOULD reflect the commit (drafts cleared, dim/map rows present).
  const drafts = await repo.listDrafts(dimId);
  expect(drafts).toHaveLength(0);

  const dim = await repo.getDimension(dimId);
  expect(dim?.canonical.some((c) => c.key === "us")).toBe(true);

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

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  // No drafts saved.
  const result = await repo.commit(dimId, "u_test");
  expect(result.committed).toBe(0);
  expect(result.warehouseSynced).toBe("n/a"); // nothing to sync
  expect(ensured).toHaveLength(0);
  expect(committed).toHaveLength(0);
});

test("commit in writable DuckDB mode: rows land in MERGE-target tables end-to-end", async () => {
  // A real DuckDbWritableAdapter against :memory:. The Postgres canonical mirror
  // also exists (via the normal pgTx path) — we're verifying both sides happen.
  const writableDuckDb = new DuckDbWritableAdapter({
    type: "duckdb",
    path: ":memory:",
    database: "memory",
    attached: false,
    writable: true,
  });

  // Pre-create the schema so ensureCanonicalTables can target it
  // @ts-expect-error — protected connect()
  const c = await writableDuckDb["connect"]();
  await c.run(`CREATE SCHEMA IF NOT EXISTS zugzug`);

  // Swap factories to return our writable DuckDB adapter for both types.
  registerFactories({
    duckdb: async () => writableDuckDb,
    snowflake: async () => writableDuckDb, // doesn't matter; test only triggers duckdb
  });
  _resetAdapterCache();

  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, "u_test");
  await repo.saveDraft(dimId, "USA", "mapped", "United States", "us", "u_test");

  const result = await repo.commit(dimId, "u_test");

  expect(result.committed).toBe(1);
  expect(result.warehouseSynced).toBe("synced");

  // Verify the writable DuckDB actually has the rows in its dim_/map_ tables.
  // Note: addDimension creates the dim under the env.canonicalSchema ("zugzug").
  const dimRows = await c.runAndReadAll(`SELECT * FROM zugzug.dim_country ORDER BY 1`);
  expect(dimRows.getRowObjects()).toEqual([{ country_code: "us", label: "United States" }]);
  const mapRows = await c.runAndReadAll(`SELECT * FROM zugzug.map_country ORDER BY raw`);
  expect(mapRows.getRowObjects()).toEqual([{ raw: "USA", country_code: "us" }]);

  // Audit log captures the sync
  const audits = await repo.listAudit(10);
  expect(audits.some((a) => a.action === "Warehouse synced")).toBe(true);
});

// Cleanup: restore real factories at end of file so subsequent test files see DuckDB
afterAll(async () => {
  registerFactories({
    duckdb: async (creds) => createDuckDbAdapter(creds),
    snowflake: async (creds) => new SnowflakeAdapter(creds),
  });
  _resetAdapterCache();
});
