import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./env.ts";

export type TxHelpers = {
  all: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  get: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T | null>;
  run: (q: string, p?: unknown[]) => Promise<void>;
};

interface PgContext {
  insideTenantRepo: boolean;
  /** When set, pgAll/pgGet/pgRun route through this tx instead of the pool.
   *  pgTxScoped populates this so repo queries automatically run inside the
   *  per-tenant transaction with SET LOCAL app.tenant_id. */
  tx?: TxHelpers;
}
export const pgContext = new AsyncLocalStorage<PgContext>();

/** Throws if executing inside a TenantRepo-gated route ctx and the caller bypassed
 *  TenantRepo to call pg.* directly. No-op in production. Skipped when tx is set
 *  (then routing through tx is the intended path). */
export function assertNotInsideTenantRepo(fnName: string): void {
  if (process.env.NODE_ENV === "production") return;
  const ctx = pgContext.getStore();
  if (ctx?.tx) return; // routing through tx — this is the happy path
  if (ctx?.insideTenantRepo) {
    throw new Error(
      `pg.${fnName} called from inside a TenantRepo route context without tx — use req.repo.* instead`,
    );
  }
}

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
  const ctx = pgContext.getStore();
  if (ctx?.tx) return ctx.tx.all<T>(query, params);
  assertNotInsideTenantRepo("pgAll");
  const rows = await pool.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
  return rows as unknown as T[];
}

export async function pgGet<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const ctx = pgContext.getStore();
  if (ctx?.tx) return ctx.tx.get<T>(query, params);
  assertNotInsideTenantRepo("pgGet");
  const rows = await pool.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
  return (rows as unknown as T[])[0] ?? null;
}

export async function pgRun(query: string, params: unknown[] = []): Promise<void> {
  const ctx = pgContext.getStore();
  if (ctx?.tx) {
    await ctx.tx.run(query, params);
    return;
  }
  assertNotInsideTenantRepo("pgRun");
  await pool.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
}

export function pgTxRaw<T>(fn: (tx: TxHelpers) => Promise<T>): Promise<T> {
  assertNotInsideTenantRepo("pgTxRaw");
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

/** Open a per-tenant transaction with `SET LOCAL app.tenant_id` set, and
 *  populate pgContext.tx so pgAll/pgGet/pgRun called inside the callback
 *  automatically route through this tx connection. */
export function pgTxScoped<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
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
    return pgContext.run({ insideTenantRepo: true, tx: helpers }, () => fn());
  }) as Promise<T>;
}
