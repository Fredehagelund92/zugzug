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
      attached: true,
      writable: e.motherduckWritable,
    };
  }
  if (e.warehouseAdapter === "duckdb") {
    return { type: "duckdb", path: e.duckWarehousePath, attached: true, writable: false };
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
