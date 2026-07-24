import { env } from "../env.ts";
import { resolveAdapter } from "./credentials.ts";
import type { WarehouseAdapter } from "./adapter.ts";

let cached: Promise<WarehouseAdapter> | null = null;

async function build(): Promise<WarehouseAdapter> {
  if (env.warehouseAdapter === "disabled") {
    return resolveAdapter({
      type: "duckdb",
      attached: false,
      writable: false,
    });
  }
  if (env.warehouseAdapter === "motherduck") {
    return resolveAdapter({
      type: "duckdb",
      token: env.motherduckToken,
      attached: true,
      writable: env.motherduckWritable,
    });
  }
  if (env.warehouseAdapter === "duckdb") {
    return resolveAdapter({
      type: "duckdb",
      path: env.duckWarehousePath,
      attached: true,
      writable: false,
    });
  }
  throw new Error(`unsupported warehouse adapter: ${env.warehouseAdapter}`);
}

export async function getAdapter(): Promise<WarehouseAdapter> {
  if (!cached) cached = build();
  return cached;
}

export function _resetAdapterCache(): void {
  cached = null;
}
