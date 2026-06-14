import { createHash, randomUUID } from "node:crypto";
import { pgAll, pgGet, pgRun } from "./pg.ts";
import { encryptCredentials } from "./warehouse/crypto.ts";
import type { WarehouseCredentials } from "./warehouse/credentials.ts";
import { evictAdapter } from "./warehouse/registry.ts";

export interface ConnectionRow {
  id: string;
  tenantId: string;
  adapter: string;
  label: string;
  credentialsVersion: number;
  lastVerifiedAt: Date | null;
  lastVerifyError: string | null;
}

export interface DatabaseRow {
  id: string;
  databaseName: string;
  label: string | null;
  addedAt: Date;
  sourceCount: number;
  lastProbeAt: Date | null;
  lastProbeError: string | null;
}

function newId(prefix: "wc" | "wd"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export async function getWarehouseConnection(tenantId: string): Promise<ConnectionRow | null> {
  const row = await pgGet<{
    id: string;
    adapter: string;
    label: string;
    credentials_version: number;
    last_verified_at: Date | null;
    last_verify_error: string | null;
  }>(
    `SELECT id, adapter, label, credentials_version, last_verified_at, last_verify_error
       FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!row) return null;
  return {
    id: row.id,
    tenantId,
    adapter: row.adapter,
    label: row.label,
    credentialsVersion: row.credentials_version,
    lastVerifiedAt: row.last_verified_at,
    lastVerifyError: row.last_verify_error,
  };
}

export async function createWarehouseConnection(opts: {
  tenantId: string;
  adapter: "motherduck" | "duckdb_local";
  label: string;
  credentials: WarehouseCredentials;
  actorUserId: string;
}): Promise<ConnectionRow> {
  const id = newId("wc");
  const plaintext = JSON.stringify(opts.credentials);
  const blob = encryptCredentials(plaintext, `${opts.tenantId}:${id}`);
  const hash = createHash("sha256").update(plaintext).digest("hex");
  try {
    await pgRun(
      `INSERT INTO "zugzug_app"."warehouse_connection"
         (id, tenant_id, adapter, label, credentials_encrypted, credentials_hash, credentials_version, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, now(), $7)`,
      [id, opts.tenantId, opts.adapter, opts.label, blob, hash, opts.actorUserId],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/warehouse_connection_one_per_tenant/.test(msg)) {
      throw new Error("a warehouse connection already exists for this tenant");
    }
    throw err;
  }
  const created = await getWarehouseConnection(opts.tenantId);
  if (!created) throw new Error("connection not visible after insert");
  return created;
}

export async function listWarehouseDatabases(tenantId: string): Promise<DatabaseRow[]> {
  return pgAll<DatabaseRow>(
    `SELECT wd.id            AS "id",
            wd.database_name AS "databaseName",
            wd.label         AS "label",
            wd.added_at      AS "addedAt",
            wd.last_probe_at AS "lastProbeAt",
            wd.last_probe_error AS "lastProbeError",
            (SELECT count(*)::int FROM "zugzug_app"."dimension_source" ds
               WHERE ds.tenant_id = wd.tenant_id AND ds.database_id = wd.id) AS "sourceCount"
       FROM "zugzug_app"."warehouse_database" wd
      WHERE wd.tenant_id = $1
      ORDER BY wd.added_at`,
    [tenantId],
  );
}

export async function addWarehouseDatabase(opts: {
  tenantId: string;
  connectionId: string;
  databaseName: string;
  label?: string;
  actorUserId: string;
}): Promise<DatabaseRow> {
  const id = newId("wd");
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database"
       (id, tenant_id, connection_id, database_name, label, added_at, added_by)
     VALUES ($1, $2, $3, $4, $5, now(), $6)`,
    [id, opts.tenantId, opts.connectionId, opts.databaseName, opts.label ?? null, opts.actorUserId],
  );
  const list = await listWarehouseDatabases(opts.tenantId);
  const found = list.find((d) => d.id === id);
  if (!found) throw new Error("database not visible after insert");
  return found;
}

export type PatchConnectionResult =
  | { ok: true; row: ConnectionRow }
  | { ok: false; reason: "STALE_VERSION"; currentVersion: number };

/** PATCH the connection row with optimistic-concurrency on credentials_version.
 *  - If credentials are passed and their SHA-256 matches the stored hash, the
 *    row is NOT touched on the credentials columns and the version is NOT bumped.
 *  - If credentials are passed and differ, re-encrypt + bump credentials_version
 *    and evict the cached adapter.
 *  - Optional `label` is updated independently.
 *  - Returns STALE_VERSION when expectedVersion doesn't match the current row.
 */
export async function patchWarehouseConnection(opts: {
  tenantId: string;
  expectedVersion: number;
  label?: string;
  credentials?: WarehouseCredentials;
  actorUserId: string;
}): Promise<PatchConnectionResult> {
  const existing = await getWarehouseConnection(opts.tenantId);
  if (!existing) {
    throw new Error("warehouse_connection not found for tenant");
  }
  if (existing.credentialsVersion !== opts.expectedVersion) {
    return { ok: false, reason: "STALE_VERSION", currentVersion: existing.credentialsVersion };
  }

  let bumpCredentials = false;
  let newBlob: string | null = null;
  let newHash: string | null = null;

  if (opts.credentials !== undefined) {
    const plaintext = JSON.stringify(opts.credentials);
    newHash = createHash("sha256").update(plaintext).digest("hex");
    // Compare to the stored hash without round-tripping the encrypted blob.
    const stored = await pgGet<{ credentials_hash: string }>(
      `SELECT credentials_hash FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
      [opts.tenantId],
    );
    if (!stored) throw new Error("warehouse_connection row vanished mid-patch");
    if (stored.credentials_hash !== newHash) {
      bumpCredentials = true;
      newBlob = encryptCredentials(plaintext, `${opts.tenantId}:${existing.id}`);
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (opts.label !== undefined) {
    sets.push(`label = $${i++}`);
    params.push(opts.label);
  }
  if (bumpCredentials && newBlob !== null && newHash !== null) {
    sets.push(`credentials_encrypted = $${i++}`);
    params.push(newBlob);
    sets.push(`credentials_hash = $${i++}`);
    params.push(newHash);
    sets.push(`credentials_version = credentials_version + 1`);
  }

  if (sets.length === 0) {
    // No-op (e.g. credentials passed but unchanged, label unchanged) — return current row.
    return { ok: true, row: existing };
  }

  // Optimistic-concurrency guard: UPDATE ... WHERE credentials_version = $expected
  // RETURNING credentials_version. If the race was lost between the read above and
  // this UPDATE, no row is returned.
  const tenantIdx = i++;
  const versionIdx = i++;
  params.push(opts.tenantId);
  params.push(opts.expectedVersion);
  const updated = await pgGet<{ credentials_version: number }>(
    `UPDATE "zugzug_app"."warehouse_connection"
        SET ${sets.join(", ")}
      WHERE tenant_id = $${tenantIdx} AND credentials_version = $${versionIdx}
      RETURNING credentials_version`,
    params,
  );
  if (!updated) {
    const current = await getWarehouseConnection(opts.tenantId);
    return {
      ok: false,
      reason: "STALE_VERSION",
      currentVersion: current?.credentialsVersion ?? existing.credentialsVersion,
    };
  }

  if (bumpCredentials) {
    evictAdapter(opts.tenantId, existing.id);
  }

  const fresh = await getWarehouseConnection(opts.tenantId);
  if (!fresh) throw new Error("connection not visible after patch");
  return { ok: true, row: fresh };
}

export type DeleteConnectionResult =
  | { ok: true }
  | { ok: false; reason: "IN_USE"; databaseCount: number };

export async function deleteWarehouseConnection(
  tenantId: string,
): Promise<DeleteConnectionResult> {
  const countRow = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`,
    [tenantId],
  );
  const databaseCount = countRow?.n ?? 0;
  if (databaseCount > 0) {
    return { ok: false, reason: "IN_USE", databaseCount };
  }
  await pgRun(
    `DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`,
    [tenantId],
  );
  return { ok: true };
}

/** Record the outcome of a verify (adapter.ping()) attempt on the connection row.
 *  Always updates last_verified_at = now(); sets last_verify_error to NULL on
 *  success or the error message on failure. */
export async function setVerifyResult(
  tenantId: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  if (outcome.ok) {
    await pgRun(
      `UPDATE "zugzug_app"."warehouse_connection"
          SET last_verified_at = now(), last_verify_error = NULL
        WHERE tenant_id = $1`,
      [tenantId],
    );
  } else {
    await pgRun(
      `UPDATE "zugzug_app"."warehouse_connection"
          SET last_verified_at = now(), last_verify_error = $2
        WHERE tenant_id = $1`,
      [tenantId, outcome.error],
    );
  }
}
