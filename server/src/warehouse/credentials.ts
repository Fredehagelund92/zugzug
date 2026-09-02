import { z } from "zod";
import type { WarehouseAdapter } from "./adapter.ts";

export const DuckDbCredentials = z.object({
  type: z.literal("duckdb"),
  // Either a MotherDuck token (cloud) OR a local file path / :memory:
  token: z.string().optional(),
  path: z.string().optional(),
  // The catalog name on MotherDuck side ("analytics", etc.). Used when qualifying refs.
  database: z.string().optional(),
  // The catalog holding the published dim_/map_ tables (writable mode). Kept
  // separate from `database` so it never becomes an implicit default for
  // catalog browsing, which refuses that fallback on purpose.
  recordDatabase: z.string().optional(),
  // When true, the adapter scans the warehouse; when false, scan methods return [].
  // Mirrors today's ATTACH_WAREHOUSE flag.
  attached: z.boolean().default(false),
  // When true, the adapter implements WritableWarehouseAdapter — commit() writes
  // record dim_*/map_* into the MotherDuck database via MERGE INTO. Off by
  // default; safe to flip on only when the MotherDuck token has write access.
  writable: z.boolean().default(false),
});

export const SnowflakeCredentials = z.object({
  type: z.literal("snowflake"),
  account: z.string(),
  user: z.string(),
  privateKey: z.string(),
  privateKeyPassphrase: z.string().optional(),
  warehouse: z.string(),
  database: z.string(),
  schema: z.string(),
});

export const WarehouseCredentialsSchema = z.discriminatedUnion("type", [
  DuckDbCredentials,
  SnowflakeCredentials,
]);

export type WarehouseCredentials = z.infer<typeof WarehouseCredentialsSchema>;
export type DuckDbCreds = z.infer<typeof DuckDbCredentials>;
export type SnowflakeCreds = z.infer<typeof SnowflakeCredentials>;

// Factory registry — mapped type forces every credential `type` to have a factory.
// Adding a new credential type without a factory entry is a compile error.
type AdapterFactory<C extends WarehouseCredentials> = (creds: C) => Promise<WarehouseAdapter>;

export interface AdapterFactoryRegistry {
  duckdb: AdapterFactory<DuckDbCreds>;
  snowflake: AdapterFactory<SnowflakeCreds>;
}

let _factories: AdapterFactoryRegistry | null = null;

export function registerFactories(reg: AdapterFactoryRegistry): void {
  _factories = reg;
}

export async function resolveAdapter(raw: unknown): Promise<WarehouseAdapter> {
  if (!_factories) {
    throw new Error("warehouse factories not registered — call registerFactories() at startup");
  }
  const creds = WarehouseCredentialsSchema.parse(raw);
  // Per-type narrowing: TS infers `creds` to the exact factory's input type.
  switch (creds.type) {
    case "duckdb":
      return _factories.duckdb(creds);
    case "snowflake":
      return _factories.snowflake(creds);
  }
}
