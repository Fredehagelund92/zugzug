process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { SnowflakeAdapter } from "../src/warehouse/snowflake/index.ts";
import type { SnowflakeConnection } from "../src/warehouse/snowflake/sdk-wrapper.ts";
import type { SnowflakeCreds } from "../src/warehouse/credentials.ts";

const CREDS: SnowflakeCreds = {
  type: "snowflake",
  account: "abc123.eu-west-1",
  user: "BOT",
  privateKey: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----",
  warehouse: "WH",
  database: "ANALYTICS",
  schema: "PUBLIC",
};

// MockConnection captures every execute() call and returns canned rows.
interface ExecuteCall {
  sqlText: string;
  binds?: unknown[];
}

function mockConn(responder: (call: ExecuteCall) => Record<string, unknown>[]): {
  conn: SnowflakeConnection;
  calls: ExecuteCall[];
} {
  const calls: ExecuteCall[] = [];
  const conn: SnowflakeConnection = {
    async execute(opts) {
      calls.push({ sqlText: opts.sqlText, binds: opts.binds });
      return responder({ sqlText: opts.sqlText, binds: opts.binds });
    },
    async executeAffected(opts) {
      calls.push({ sqlText: opts.sqlText, binds: opts.binds });
      const rows = responder({ sqlText: opts.sqlText, binds: opts.binds });
      // Tests fake "rows affected" via a special _affected column.
      const first = rows[0] as { _affected?: number } | undefined;
      return first?._affected ?? 0;
    },
    async close() {},
  };
  return { conn, calls };
}

test("quoteIdentifier wraps in double quotes and escapes embedded quotes", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.quoteIdentifier("FOO")).toBe('"FOO"');
  expect(a.quoteIdentifier('weird"name')).toBe('"weird""name"');
});

test("qualifyRef builds database.schema.table 3-part, defaulting database from creds", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.qualifyRef({ schema: "RAW", table: "PARTNERS" })).toBe('"ANALYTICS"."RAW"."PARTNERS"');
});

test("qualifyRef respects explicit catalog override on the Ref", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.qualifyRef({ catalog: "OTHER_DB", schema: "RAW", table: "T" })).toBe(
    '"OTHER_DB"."RAW"."T"',
  );
});

test("castToString wraps in CAST(... AS VARCHAR) — Snowflake accepts this", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.castToString('"COL"')).toBe('CAST("COL" AS VARCHAR)');
});

test("capabilities are writable Snowflake defaults", () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  expect(a.capabilities.id).toBe("snowflake");
  expect(a.capabilities.writable).toBe(true);
  expect(a.capabilities.supportsMerge).toBe(true);
  expect(a.capabilities.identifierCase).toBe("upper");
  expect(a.capabilities.supportsApproximateDistinct).toBe(true);
});

test("ping returns true when SELECT 1 succeeds", async () => {
  const { conn, calls } = mockConn((call) => {
    if (call.sqlText.trim().toUpperCase() === "SELECT 1 AS OK") {
      return [{ OK: 1 }]; // Snowflake returns column names UPPERCASE by default
    }
    return [];
  });
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.ping()).resolves.toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].sqlText.trim()).toBe("SELECT 1 AS OK");
});

test("ping returns false when connection throws", async () => {
  const conn: SnowflakeConnection = {
    async execute() {
      throw new Error("connection refused");
    },
    async executeAffected() {
      return 0;
    },
    async close() {},
  };
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.ping()).resolves.toBe(false);
});

test("tableExists: returns true when SELECT 1 ... LIMIT 0 succeeds", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const ok = await a.tableExists({ schema: "RAW", table: "PARTNERS" });
  expect(ok).toBe(true);
  expect(calls[0].sqlText).toContain('SELECT 1 FROM "ANALYTICS"."RAW"."PARTNERS" LIMIT 0');
});

test("tableExists: returns false when execute throws", async () => {
  const conn: SnowflakeConnection = {
    async execute() {
      throw new Error("Table 'ANALYTICS.RAW.NOPE' does not exist");
    },
    async executeAffected() {
      return 0;
    },
    async close() {},
  };
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.tableExists({ schema: "RAW", table: "NOPE" })).resolves.toBe(false);
});

test("listTables: queries INFORMATION_SCHEMA.TABLES + COLUMNS, merges by (schema, table)", async () => {
  const { conn, calls } = mockConn((call) => {
    if (call.sqlText.includes("INFORMATION_SCHEMA.TABLES")) {
      return [
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "COUNTRIES" },
      ];
    }
    if (call.sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
      return [
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS", COLUMN_NAME: "ID" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS", COLUMN_NAME: "NAME" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "PARTNERS", COLUMN_NAME: "REGION" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "COUNTRIES", COLUMN_NAME: "CODE" },
        { TABLE_SCHEMA: "RAW", TABLE_NAME: "COUNTRIES", COLUMN_NAME: "LABEL" },
      ];
    }
    return [];
  });
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const tables = await a.listTables({});
  expect(tables).toHaveLength(2);
  const partners = tables.find((t) => t.table === "PARTNERS");
  expect(partners?.schema).toBe("RAW");
  expect(partners?.columns).toEqual(["ID", "NAME", "REGION"]);
  // Confirms two-query strategy (TABLES + COLUMNS), not a single join (which is fine but slower at scale)
  expect(calls.length).toBe(2);
});

test("listTables: schema filter narrows the WHERE clause", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.listTables({ schema: "MARKETING" });
  // Both queries (TABLES and COLUMNS) should bind the schema filter
  for (const c of calls) {
    expect(c.binds).toContain("MARKETING");
  }
});

test("listTables: search filter applies to schema, table, or column name", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.listTables({ search: "partner" });
  // search becomes %partner% bound to the ILIKE pattern (case-insensitive)
  const allBinds = calls.flatMap((c) => c.binds ?? []);
  expect(allBinds).toContain("%partner%");
});

test("listColumns: returns name + type from INFORMATION_SCHEMA.COLUMNS", async () => {
  const { conn, calls } = mockConn((call) => {
    if (call.sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
      return [
        { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER" },
        { COLUMN_NAME: "NAME", DATA_TYPE: "VARCHAR" },
      ];
    }
    return [];
  });
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const cols = await a.listColumns({ schema: "RAW", table: "PARTNERS" });
  expect(cols).toEqual([
    { name: "ID", type: "NUMBER" },
    { name: "NAME", type: "VARCHAR" },
  ]);
  // Confirms the query binds schema and table separately
  expect(calls[0].binds).toEqual(["RAW", "PARTNERS"]);
});

test("distinctValues: SELECT DISTINCT CAST(... AS VARCHAR) ORDER BY 1 LIMIT n", async () => {
  const { conn, calls } = mockConn(() => [{ V: "EU" }, { V: "US" }, { V: "us" }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const vals = await a.distinctValues({ schema: "RAW", table: "PARTNERS" }, "REGION", 100);
  expect(vals).toEqual(["EU", "US", "us"]);
  expect(calls[0].sqlText).toContain('SELECT DISTINCT CAST("REGION" AS VARCHAR) AS V');
  expect(calls[0].sqlText).toContain('FROM "ANALYTICS"."RAW"."PARTNERS"');
  expect(calls[0].sqlText).toContain('"REGION" IS NOT NULL');
  expect(calls[0].sqlText).toContain("LIMIT 100");
});

test("distinctValues: limit is clamped to [1, 100000]", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.distinctValues({ schema: "RAW", table: "T" }, "C", 999999999);
  expect(calls[0].sqlText).toContain("LIMIT 100000");
  await a.distinctValues({ schema: "RAW", table: "T" }, "C", 0);
  expect(calls[1].sqlText).toContain("LIMIT 1");
});

test("topValuesByFrequency: GROUP BY 1 + COUNT(*) + ORDER BY n DESC", async () => {
  const { conn, calls } = mockConn(() => [
    { V: "EU", N: 2 },
    { V: "US", N: 1 },
  ]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const top = await a.topValuesByFrequency({ schema: "RAW", table: "PARTNERS" }, "REGION", 10);
  expect(top).toEqual([
    { value: "EU", count: 2 },
    { value: "US", count: 1 },
  ]);
  expect(calls[0].sqlText).toContain("GROUP BY 1");
  expect(calls[0].sqlText).toContain("ORDER BY N DESC, V");
  expect(calls[0].sqlText).toContain("LIMIT 10");
});

test("columnStats: exact mode uses COUNT + COUNT DISTINCT", async () => {
  const { conn, calls } = mockConn(() => [{ ROWS: 4, D: 3 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const s = await a.columnStats({ schema: "RAW", table: "T" }, "REGION");
  expect(s).toEqual({ rows: 4, distinct: 3 });
  expect(calls[0].sqlText).toContain('COUNT("REGION") AS ROWS');
  expect(calls[0].sqlText).toContain('COUNT(DISTINCT "REGION") AS D');
});

test("columnStats: approximate mode uses APPROX_COUNT_DISTINCT (Snowflake-native)", async () => {
  const { conn, calls } = mockConn(() => [{ ROWS: 4, D: 3 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.columnStats({ schema: "RAW", table: "T" }, "REGION", { approximate: true });
  expect(calls[0].sqlText).toContain('APPROX_COUNT_DISTINCT("REGION") AS D');
});

test("nameResolution: returns id→name Map, filters NULL ids", async () => {
  const { conn } = mockConn(() => [
    { ID: "US", NM: "United States" },
    { ID: "EU", NM: "European Union" },
  ]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const m = await a.nameResolution({ schema: "RAW", table: "COUNTRIES" }, "CODE", "LABEL");
  expect(m.size).toBe(2);
  expect(m.get("US")).toBe("United States");
  expect(m.get("EU")).toBe("European Union");
});

test("nameResolution: query includes WHERE idCol IS NOT NULL", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.nameResolution({ schema: "RAW", table: "COUNTRIES" }, "CODE", "LABEL");
  expect(calls[0].sqlText).toContain('"CODE" IS NOT NULL');
});

test("distinctValuesWithProvenance: empty sources returns []", async () => {
  const { conn } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await expect(a.distinctValuesWithProvenance([])).resolves.toEqual([]);
});

test("distinctValuesWithProvenance: UNION ALL across sources, tags sourceIndex literal", async () => {
  const { conn, calls } = mockConn(() => [
    { V: "EU", SRC_IDX: 0, N: 2 },
    { V: "US", SRC_IDX: 0, N: 1 },
    { V: "us", SRC_IDX: 0, N: 1 },
    { V: "US", SRC_IDX: 1, N: 1 },
    { V: "EU", SRC_IDX: 1, N: 1 },
  ]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const rows = await a.distinctValuesWithProvenance([
    { table: { schema: "RAW", table: "PARTNERS" }, column: "REGION" },
    { table: { schema: "RAW", table: "COUNTRIES" }, column: "CODE" },
  ]);
  expect(rows).toHaveLength(5);
  expect(rows.filter((r) => r.sourceIndex === 0)).toHaveLength(3);
  expect(rows.filter((r) => r.sourceIndex === 1)).toHaveLength(2);
  expect(rows.find((r) => r.value === "EU" && r.sourceIndex === 0)?.count).toBe(2);

  // SQL should have UNION ALL between the two source branches with the literal
  // src_idx values 0 and 1 (no parameter binding for the index).
  const sql = calls[0].sqlText;
  expect(sql).toContain("UNION ALL");
  expect(sql).toContain("0 AS SRC_IDX");
  expect(sql).toContain("1 AS SRC_IDX");
  expect(sql).toContain('"REGION"');
  expect(sql).toContain('"CODE"');
});

test("ensureRecordTables: issues CREATE TABLE IF NOT EXISTS for dim_ and map_", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.ensureRecordTables({
    dimId: "country",
    dimTable: "ZUGZUG.DIM_COUNTRY",
    mapTable: "ZUGZUG.MAP_COUNTRY",
    keyCol: "COUNTRY_CODE",
  });
  expect(calls).toHaveLength(2);
  const sqls = calls.map((c) => c.sqlText).join("\n---\n");
  expect(sqls).toContain('CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."DIM_COUNTRY"');
  expect(sqls).toContain('"COUNTRY_CODE" VARCHAR PRIMARY KEY');
  expect(sqls).toContain("LABEL VARCHAR");
  expect(sqls).toContain('CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."MAP_COUNTRY"');
  expect(sqls).toContain('"RAW" VARCHAR PRIMARY KEY');
  expect(sqls).toContain('"COUNTRY_CODE" VARCHAR NOT NULL');
});

test("commitRecord: empty drafts returns {rowsWritten: 0} without any SQL", async () => {
  const { conn, calls } = mockConn(() => []);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const result = await a.commitRecord(
    {
      dimId: "country",
      dimTable: "ZUGZUG.DIM_COUNTRY",
      mapTable: "ZUGZUG.MAP_COUNTRY",
      keyCol: "COUNTRY_CODE",
    },
    [],
  );
  expect(result.rowsWritten).toBe(0);
  expect(calls).toHaveLength(0);
});

test("commitRecord: issues two MERGE statements (dim + map)", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 3 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  const result = await a.commitRecord(
    {
      dimId: "country",
      dimTable: "ZUGZUG.DIM_COUNTRY",
      mapTable: "ZUGZUG.MAP_COUNTRY",
      keyCol: "COUNTRY_CODE",
    },
    [
      { raw: "USA", key: "US", label: "United States" },
      { raw: "U.S.", key: "US", label: "United States" },
      { raw: "United Kingdom", key: "GB", label: "United Kingdom" },
    ],
  );
  expect(calls).toHaveLength(2);
  const mergeSqls = calls.map((c) => c.sqlText);

  // First MERGE: dim_country (unique by key)
  expect(mergeSqls[0]).toContain('MERGE INTO "ANALYTICS"."ZUGZUG"."DIM_COUNTRY"');
  expect(mergeSqls[0]).toContain('"COUNTRY_CODE"');
  expect(mergeSqls[0]).toContain("USING (VALUES");
  expect(mergeSqls[0]).toContain("WHEN NOT MATCHED");

  // Second MERGE: map_country (one row per draft)
  expect(mergeSqls[1]).toContain('MERGE INTO "ANALYTICS"."ZUGZUG"."MAP_COUNTRY"');
  expect(mergeSqls[1]).toContain('"RAW"');

  // Binds carry the actual values (Snowflake VALUES with placeholders)
  const allBinds = calls.flatMap((c) => c.binds ?? []);
  expect(allBinds).toContain("US");
  expect(allBinds).toContain("United States");
  expect(allBinds).toContain("USA");
  expect(allBinds).toContain("U.S.");
  expect(allBinds).toContain("GB");

  // rowsWritten sums both MERGEs' affected counts (mock returns 3 per call)
  expect(result.rowsWritten).toBe(6);
});

test("commitRecord: dim MERGE deduplicates by key (one row per unique key, last label wins)", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 1 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.commitRecord(
    {
      dimId: "country",
      dimTable: "ZUGZUG.DIM_COUNTRY",
      mapTable: "ZUGZUG.MAP_COUNTRY",
      keyCol: "COUNTRY_CODE",
    },
    [
      { raw: "USA", key: "US", label: "United States" },
      { raw: "U.S.", key: "US", label: "United States of America" }, // same key, different label
    ],
  );
  // The dim MERGE should have ONE pair of placeholders, not two
  const dimBinds = calls[0].binds ?? [];
  expect(dimBinds).toHaveLength(2); // [key, label]
  expect(dimBinds[0]).toBe("US");
  // Last-write-wins on label (deterministic by input order)
  expect(dimBinds[1]).toBe("United States of America");
});

test("commitRecord: chunks at 1000 rows", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 1 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  // 1500 unique drafts → dim has 1500 unique keys, map has 1500 rows
  const drafts = Array.from({ length: 1500 }, (_, i) => ({
    raw: `raw-${i}`,
    key: `key-${i}`,
    label: `Label ${i}`,
  }));
  await a.commitRecord({ dimId: "x", dimTable: "S.D", mapTable: "S.M", keyCol: "K" }, drafts);
  // 2 MERGEs per chunk × 2 chunks (1000 + 500) = 4 statements
  expect(calls).toHaveLength(4);
});

test("commitRecord: handles drafts with null label (uses NULL bind)", async () => {
  const { conn, calls } = mockConn(() => [{ _affected: 1 }]);
  const a = new SnowflakeAdapter(CREDS, () => conn);
  await a.commitRecord({ dimId: "x", dimTable: "S.D", mapTable: "S.M", keyCol: "K" }, [
    { raw: "raw1", key: "k1", label: null },
  ]);
  const dimBinds = calls[0].binds ?? [];
  expect(dimBinds[0]).toBe("k1");
  expect(dimBinds[1]).toBeNull();
});
