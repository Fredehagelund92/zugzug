process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

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
