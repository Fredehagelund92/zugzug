import postgres from "postgres";
import { env } from "./env.ts";

const pool = postgres(env.databaseUrl);

export async function pgEnd(): Promise<void> {
  await pool.end();
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

type TxHelpers = {
  all: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  get: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T | null>;
  run: (q: string, p?: unknown[]) => Promise<void>;
};

export function pgTx<T>(fn: (tx: TxHelpers) => Promise<T>): Promise<T> {
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
