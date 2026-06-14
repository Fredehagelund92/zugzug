import { createHash, randomUUID } from "node:crypto";
import { pgAll, pgGet, pgRun } from "./pg.ts";
import { encryptCredentials } from "./warehouse/crypto.ts";
import type { WarehouseCredentials } from "./warehouse/credentials.ts";

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
