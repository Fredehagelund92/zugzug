import { pgGet } from "../pg.ts";
import { decryptCredentials } from "./crypto.ts";
import { resolveAdapter, type WarehouseCredentials } from "./credentials.ts";
import type { WarehouseAdapter } from "./adapter.ts";

interface CacheEntry {
  adapter: WarehouseAdapter;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, Promise<CacheEntry>>();

function cacheKey(tenantId: string, connectionId: string): string {
  return `${tenantId}:${connectionId}`;
}

async function loadAdapter(tenantId: string): Promise<CacheEntry> {
  const row = await pgGet<{ id: string; adapter: string; credentials_encrypted: string }>(
    `SELECT id, adapter, credentials_encrypted
       FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!row) {
    throw new Error("WAREHOUSE_NOT_CONFIGURED");
  }
  if (row.credentials_encrypted === "__PENDING__") {
    throw new Error("WAREHOUSE_BACKFILL_PENDING");
  }
  let plaintext: string;
  try {
    plaintext = decryptCredentials(row.credentials_encrypted, `${tenantId}:${row.id}`);
  } catch {
    throw new Error("WAREHOUSE_KEY_MISSING");
  }
  const creds = JSON.parse(plaintext) as WarehouseCredentials;
  const adapter = await resolveAdapter(creds);
  return { adapter, expiresAt: Date.now() + TTL_MS };
}

export async function getAdapter(tenantId: string): Promise<WarehouseAdapter> {
  const connRow = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!connRow) throw new Error("WAREHOUSE_NOT_CONFIGURED");
  const key = cacheKey(tenantId, connRow.id);
  const existing = cache.get(key);
  if (existing) {
    const entry = await existing;
    if (Date.now() < entry.expiresAt) return entry.adapter;
    cache.delete(key);
  }
  const promise = loadAdapter(tenantId);
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return (await promise).adapter;
}

export function evictAdapter(tenantId: string, connectionId: string): void {
  cache.delete(cacheKey(tenantId, connectionId));
}

export function _resetAdapterCache(): void {
  cache.clear();
}
