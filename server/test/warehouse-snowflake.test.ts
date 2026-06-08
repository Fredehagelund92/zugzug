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
