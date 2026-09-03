import { env } from "../env.ts";
import { resolveAdapter, type DuckDbCreds } from "./credentials.ts";
import type { WarehouseAdapter } from "./adapter.ts";

let cached: Promise<WarehouseAdapter> | null = null;

/** The fields of `env` that decide which warehouse the adapter attaches to. */
export type AdapterEnv = {
  warehouseAdapter: "disabled" | "motherduck" | "duckdb";
  motherduckToken: string;
  motherduckWritable: boolean;
  duckWarehousePath: string;
  /** ZUGZUG_DB — the store Zugzug owns and writes dim_/map_ into. It is the
   *  Postgres schema in the default mode and, on MotherDuck, also names the
   *  catalog those tables live in. */
  recordSchema: string;
};

/** Pure: map env to the DuckDB credentials the adapter is built from. */
export function adapterConfigFor(e: AdapterEnv): DuckDbCreds {
  if (e.warehouseAdapter === "disabled") {
    return { type: "duckdb", attached: false, writable: false };
  }
  if (e.warehouseAdapter === "motherduck") {
    return {
      type: "duckdb",
      token: e.motherduckToken,
      // A token connection has no current catalog, so qualifyRef refuses a Ref
      // without one. The stored dim_/map_ names are two-part ("<ZUGZUG_DB>.dim_x"),
      // so without this every writable-mode publish threw "missing catalog".
      recordDatabase: e.recordSchema,
      attached: true,
      writable: e.motherduckWritable,
    };
  }
  if (e.warehouseAdapter === "duckdb") {
    // A local warehouse file honours the same opt-in flag — otherwise no
    // configuration can exercise the writable path at all.
    return {
      type: "duckdb",
      path: e.duckWarehousePath,
      attached: true,
      writable: e.motherduckWritable,
    };
  }
  throw new Error(`unsupported warehouse adapter: ${e.warehouseAdapter}`);
}

async function build(): Promise<WarehouseAdapter> {
  return resolveAdapter(adapterConfigFor(env));
}

export async function getAdapter(): Promise<WarehouseAdapter> {
  if (!cached) cached = build();
  return cached;
}

export function _resetAdapterCache(): void {
  cached = null;
}
