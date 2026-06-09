import type { WarehouseAdapter } from "./adapter.ts";
import { resolveAdapter, type WarehouseCredentials } from "./credentials.ts";
import { env } from "../env.ts";

// One adapter instance per cache key. Phase 1 has a single global workspace
// keyed by "default". Phase 4 (multi-tenant gating) keys by workspace id.
const cache = new Map<string, Promise<WarehouseAdapter>>();

export async function getAdapter(workspaceId: string = "default"): Promise<WarehouseAdapter> {
  const existing = cache.get(workspaceId);
  if (existing) return existing;
  const promise = resolveAdapter(envCredentials());
  cache.set(workspaceId, promise);
  // If the promise rejects, drop the cached failure so the next call retries.
  promise.catch(() => cache.delete(workspaceId));
  return promise;
}

/** Read warehouse credentials from env. Phase 4 replaces this with a per-workspace
 *  jsonb column in Postgres. */
function envCredentials(): WarehouseCredentials {
  return {
    type: "duckdb",
    token: env.motherduckToken,
    path: env.duckPath,
    database: env.warehouseDb,
    attached: env.attachWarehouse,
    writable: false,
  };
}

/** Test/debug helper — clears the adapter cache. */
export function _resetAdapterCache(): void {
  cache.clear();
}
