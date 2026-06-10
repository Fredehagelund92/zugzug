import { pgAll } from "./pg.ts";
import { getAdapter } from "./warehouse/registry.ts";

export interface HealthSnapshot {
  warehouse: { status: "ok" | "error" | "disabled"; lastCheckedAt: string; error?: string };
  postgres: { status: "ok" | "error"; lastCheckedAt: string; error?: string };
}

const HEALTH_CACHE_TTL_MS = 5_000;
let healthCache: { snapshot: HealthSnapshot; at: number } | null = null;

/** Test-only: clear the in-memory health cache so tests start clean. */
export function _resetHealthCache(): void {
  healthCache = null;
}

export async function checkHealth(opts: { force?: boolean } = {}): Promise<HealthSnapshot> {
  const now = Date.now();
  if (!opts.force && healthCache && now - healthCache.at < HEALTH_CACHE_TTL_MS) {
    return healthCache.snapshot;
  }

  const at = new Date().toISOString();
  const warehouseAttached = process.env.ATTACH_WAREHOUSE === "true";

  const pgCheck = (async () => {
    try {
      await pgAll(`SELECT 1`);
      return { status: "ok" as const, lastCheckedAt: at };
    } catch (e) {
      return {
        status: "error" as const,
        lastCheckedAt: at,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  })();

  const whCheck = (async () => {
    if (!warehouseAttached) {
      return { status: "disabled" as const, lastCheckedAt: at };
    }
    try {
      const warehouseAdapter = await getAdapter();
      const ok = await warehouseAdapter.ping();
      if (!ok) {
        return { status: "error" as const, lastCheckedAt: at, error: "ping returned false" };
      }
      return { status: "ok" as const, lastCheckedAt: at };
    } catch (e) {
      return {
        status: "error" as const,
        lastCheckedAt: at,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  })();

  const [postgres, warehouse] = await Promise.all([pgCheck, whCheck]);
  const snapshot: HealthSnapshot = { warehouse, postgres };
  healthCache = { snapshot, at: now };
  return snapshot;
}
