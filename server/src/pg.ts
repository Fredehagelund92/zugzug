import postgres from "postgres";
import { env } from "./env.ts";

const pool = postgres(env.databaseUrl, {
  max: Number(process.env.PG_POOL_MAX) || 5,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false, // postgres.js prepared-stmt cache fights pgbouncer transaction mode
});

export async function pgEnd(): Promise<void> {
  await pool.end({ timeout: 5 });
}

export async function pgAll<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await pool.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
  return rows as unknown as T[];
}

export async function pgGet<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await pgAll<T>(query, params);
  return rows[0] ?? null;
}

export async function pgRun(query: string, params: unknown[] = []): Promise<void> {
  await pool.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
}

export type TxHelpers = {
  all: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  get: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T | null>;
  run: (q: string, p?: unknown[]) => Promise<void>;
};

export function pgTxRaw<T>(fn: (tx: TxHelpers) => Promise<T>): Promise<T> {
  return pool.begin(async (txSql) => {
    const helpers: TxHelpers = {
      all: async <U = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<U[]> => {
        const rows = await txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]);
        return rows as unknown as U[];
      },
      get: async <U = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<U | null> => {
        const rows = await helpers.all<U>(q, p);
        return rows[0] ?? null;
      },
      run: async (q: string, p: unknown[] = []): Promise<void> => {
        await txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]);
      },
    };
    return fn(helpers) as unknown as T;
  }) as Promise<T>;
}

// Alias: legacy name. New code should call pgTxRaw or pgTxScoped explicitly.
export const pgTx = pgTxRaw;

const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$|^\*$/;
// '*' is the super-admin wildcard; RLS in Deploy 2 treats '*' as "no filter".

export function pgTxScoped<T>(tenantId: string, fn: (tx: TxHelpers) => Promise<T>): Promise<T> {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`pgTxScoped: invalid tenant id '${tenantId}'`);
  }
  return pool.begin(async (txSql) => {
    // SET LOCAL is bound to the surrounding tx; postgres.js bridges this transparently.
    // Quote the value (it's already validated against the regex) — pg.query parameters
    // don't substitute into SET statements per Postgres semantics.
    await txSql.unsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const helpers: TxHelpers = {
      all: async <U = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<U[]> => {
        const rows = await txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]);
        return rows as unknown as U[];
      },
      get: async <U = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<U | null> => {
        const rows = await helpers.all<U>(q, p);
        return rows[0] ?? null;
      },
      run: async (q: string, p: unknown[] = []): Promise<void> => {
        await txSql.unsafe(q, p as postgres.ParameterOrJSON<never>[]);
      },
    };
    return fn(helpers) as unknown as T;
  }) as Promise<T>;
}
