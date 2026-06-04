import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { env } from "./env.ts";

let _conn: DuckDBConnection | null = null;
let _connecting: Promise<DuckDBConnection> | null = null;

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  // Don't let a previous rejection poison the queue — chain off a settled tail.
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next as Promise<T>;
}

async function attachMotherDuck(conn: DuckDBConnection): Promise<void> {
  await conn.run(`INSTALL motherduck`);
  await conn.run(`LOAD motherduck`);
  process.env.motherduck_token = env.motherduckToken;
  await conn.run(`ATTACH IF NOT EXISTS 'md:'`);
}

/** Returns the one live DuckDB connection (warehouse-only — no Postgres ATTACH).
 *  Call only when a warehouse query is about to run. */
export async function connect(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  if (_connecting) return _connecting;
  _connecting = (async () => {
    const inst = await DuckDBInstance.create(env.duckPath);
    const conn = await inst.connect();
    if (env.attachWarehouse) {
      await attachMotherDuck(conn);
    } else {
      console.warn(
        "⚠ warehouse (MotherDuck) attach deferred — set ATTACH_WAREHOUSE=true to enable the scan",
      );
    }
    _conn = conn;
    return conn;
  })();
  return _connecting;
}

/* ---- query helpers (positional $1 params; Unicode/quote-safe via binding) ---- */

export async function all<T = Record<string, unknown>>(
  sql: string,
  params: DuckDBValue[] = [],
): Promise<T[]> {
  return serialized(async () => {
    const conn = await connect();
    const reader = await conn.runAndReadAll(sql, params);
    return reader.getRowObjects() as T[];
  });
}

export async function get<T = Record<string, unknown>>(
  sql: string,
  params: DuckDBValue[] = [],
): Promise<T | null> {
  return serialized(async () => {
    const conn = await connect();
    const reader = await conn.runAndReadAll(sql, params);
    const rows = reader.getRowObjects() as T[];
    return rows[0] ?? null;
  });
}

export async function run(sql: string, params: DuckDBValue[] = []): Promise<void> {
  return serialized(async () => {
    const conn = await connect();
    await conn.run(sql, params);
  });
}

/** Run fn inside a DuckDB transaction (rolls back on throw). The entire
 *  transaction occupies one queue slot so no other DuckDB statement can
 *  interleave between BEGIN and COMMIT/ROLLBACK. The callback MUST use the
 *  provided conn directly — do NOT call all/get/run inside fn, as those also
 *  serialize and will deadlock.
 *
 *  Note: a transaction spanning two ATTACHed remotes is not 2-phase-committed
 *  — keep MotherDuck writes idempotent (NOT EXISTS) so a partial failure is
 *  safe to retry. */
export async function tx<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  return serialized(async () => {
    const conn = await connect();
    await conn.run("BEGIN");
    try {
      const out = await fn(conn);
      await conn.run("COMMIT");
      return out;
    } catch (e) {
      await conn.run("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}
