import { randomUUID } from "node:crypto";
import { pgAll, pgGet, pgRun } from "./pg.ts";
import { getAdapter } from "./warehouse/registry.ts";

// MotherDuck SHOW DATABASES surfaces system catalogs that aren't user data
// — exclude them so they never appear as registerable sources.
const SYSTEM_CATALOG_NAMES = new Set(["memory", "system", "temp"]);
function isSystemCatalog(name: string): boolean {
  if (SYSTEM_CATALOG_NAMES.has(name)) return true;
  if (/_information_schema$/i.test(name)) return true;
  return false;
}

export interface DatabaseRow {
  id: string;
  databaseName: string;
  label: string | null;
  addedAt: Date;
  sourceCount: number;
  /** Snapshot from the last refreshSchemaCounts() — `null` if never counted. */
  schemaCount: number | null;
  lastProbeAt: Date | null;
  lastProbeError: string | null;
}

function newId(prefix: "wd"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/** Discover databases visible to the warehouse adapter, marking which are
 *  already registered. Filters system catalogs (memory, *_information_schema). */
export async function discoverDatabases(): Promise<
  Array<{ databaseName: string; registered: boolean }>
> {
  const adapter = await getAdapter();
  const raw = (await adapter.listDatabases()).map((d) => d.databaseName);
  const discovered = raw.filter((n) => !isSystemCatalog(n));
  const registered = new Set((await listWarehouseDatabases()).map((d) => d.databaseName));
  return discovered.map((databaseName) => ({
    databaseName,
    registered: registered.has(databaseName),
  }));
}

export async function listWarehouseDatabases(): Promise<DatabaseRow[]> {
  return pgAll<DatabaseRow>(
    `SELECT wd.id            AS "id",
            wd.database_name AS "databaseName",
            wd.label         AS "label",
            wd.added_at      AS "addedAt",
            wd.schema_count  AS "schemaCount",
            wd.last_probe_at AS "lastProbeAt",
            wd.last_probe_error AS "lastProbeError",
            (SELECT count(*)::int FROM "zugzug_app"."reference_table_source" ds
               WHERE ds.database_id = wd.id) AS "sourceCount"
       FROM "zugzug_app"."warehouse_database" wd
      ORDER BY wd.added_at`,
  );
}

/** Snapshot the warehouse's per-database schema counts into Postgres so the
 *  list above never blocks on a live warehouse query. Never throws — callers
 *  fire-and-forget it; a failure just leaves the stored counts untouched. */
export async function refreshSchemaCounts(): Promise<void> {
  try {
    const adapter = await getAdapter();
    const counts = await adapter.schemaCounts();
    for (const [databaseName, n] of counts) {
      await pgRun(
        `UPDATE "zugzug_app"."warehouse_database" SET schema_count = $1 WHERE database_name = $2`,
        [n, databaseName],
      );
    }
  } catch (err) {
    console.warn("[warehouse] schemaCounts failed:", err instanceof Error ? err.message : err);
  }
}

/** Probe every registered database and persist the outcome, resolving the
 *  "not checked yet" badge. Never throws — callers fire-and-forget it. */
export async function probeRegisteredDatabases(): Promise<void> {
  try {
    const adapter = await getAdapter();
    const rows = await pgAll<{ id: string; databaseName: string }>(
      `SELECT id AS "id", database_name AS "databaseName"
         FROM "zugzug_app"."warehouse_database"`,
    );
    for (const row of rows) {
      const result = await adapter.probeDatabase(row.databaseName);
      await pgRun(
        `UPDATE "zugzug_app"."warehouse_database"
            SET last_probe_at = now(), last_probe_error = $1
          WHERE id = $2`,
        [result.ok ? null : result.reason, row.id],
      );
    }
  } catch (err) {
    console.warn("[warehouse] probe failed:", err instanceof Error ? err.message : err);
  }
}

export async function addWarehouseDatabase(opts: {
  databaseName: string;
  label?: string;
  actorUserId: string;
}): Promise<DatabaseRow> {
  const id = newId("wd");
  try {
    await pgRun(
      `INSERT INTO "zugzug_app"."warehouse_database"
         (id, database_name, label, added_at, added_by)
       VALUES ($1, $2, $3, now(), $4)`,
      [id, opts.databaseName, opts.label ?? null, opts.actorUserId],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/warehouse_database_database_name_uniq/.test(msg)) {
      throw new Error("a warehouse database with this name already exists", { cause: err });
    }
    throw err;
  }
  await refreshSchemaCounts();
  await probeRegisteredDatabases();
  const rows = await listWarehouseDatabases();
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error("database not visible after insert");
  return row;
}

/** Update only the human label on a registered warehouse database. */
export async function updateDatabaseLabel(databaseId: string, label: string | null): Promise<void> {
  await pgRun(`UPDATE "zugzug_app"."warehouse_database" SET label = $1 WHERE id = $2`, [
    label,
    databaseId,
  ]);
}

export async function removeDatabase(
  databaseId: string,
  opts: { force: boolean } = { force: false },
): Promise<
  | { ok: true; snapshot: { databaseName: string; label: string | null; sourceCount: number } }
  | { ok: false; sourceCount: number; refTables: Array<{ refTableId: string; sources: string[] }> }
> {
  const row = await pgGet<{ database_name: string; label: string | null }>(
    `SELECT database_name, label FROM "zugzug_app"."warehouse_database" WHERE id = $1`,
    [databaseId],
  );
  if (!row) throw new Error("DATABASE_NOT_FOUND");

  const sources = await pgAll<{
    reference_table_id: string;
    schema_name: string;
    table_name: string;
    column_name: string;
  }>(
    `SELECT reference_table_id, schema_name, table_name, column_name
       FROM "zugzug_app"."reference_table_source"
      WHERE database_id = $1`,
    [databaseId],
  );
  if (sources.length > 0 && !opts.force) {
    const byDim = new Map<string, string[]>();
    for (const s of sources) {
      const arr = byDim.get(s.reference_table_id) ?? [];
      arr.push(`${s.schema_name}.${s.table_name}.${s.column_name}`);
      byDim.set(s.reference_table_id, arr);
    }
    return {
      ok: false,
      sourceCount: sources.length,
      refTables: Array.from(byDim, ([refTableId, sources]) => ({ refTableId, sources })),
    };
  }

  if (opts.force) {
    await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE database_id = $1`, [
      databaseId,
    ]);
  }

  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE id = $1`, [databaseId]);

  return {
    ok: true,
    snapshot: {
      databaseName: row.database_name,
      label: row.label,
      sourceCount: sources.length,
    },
  };
}
