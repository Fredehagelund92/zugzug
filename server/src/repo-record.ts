/* repo-record.ts — refTable registry + record CRUD + field/column management.
 *
 * All data lives in Postgres (dim_/map_ tables in the record schema +
 * the app-state refTable/reference_table_field tables). Warehouse (DuckDB) is
 * touched only in getRefTable (to resolve live names for external_id refTables). */

import { getAdapter } from "./warehouse/registry.ts";
import {
  type RefTableMeta,
  type MappingRefTable,
  type RecordValue,
  type FieldDef,
  type OptionDef,
  type PaletteName,
  type NumberFormat,
  type FormulaConfig,
  PALETTE_NAMES,
  refForRegisteredTable,
  slug,
  qid,
  cq,
  refTableMeta,
  type RefTableBasics,
  parseFieldConfig,
  pgAll,
  pgGet,
  pgRun,
  pgTx,
  env,
  pg,
} from "./repo-shared.ts";
import { getSourceScanScalars, type SourceScanScalars } from "./repo-source-scan.ts";
import {
  runFormula,
  coerceToResultType,
  isFormulaError,
  validateFormula,
} from "./formula/index.ts";
import { appendAuditAs } from "./repo-meta.ts";
import { dispatchOutbound } from "./repo-outbound-events.ts";
import { AppError } from "./errors.ts";

/** Returns the new position for an insert between pAbove and pBelow, or null
 *  if the gap is <= 1 (caller must rebalance first).
 *  pAbove = position of row above the insertion point (null = inserting at top).
 *  pBelow = position of row below the insertion point (null = inserting at bottom). */
export function computeInsertPosition(pAbove: bigint | null, pBelow: bigint | null): bigint | null {
  if (pAbove === null && pBelow === null) return 1024n;
  if (pAbove === null) return pBelow! - 1024n;
  if (pBelow === null) return pAbove + 1024n;
  const gap = pBelow - pAbove;
  if (gap <= 1n) return null;
  return pAbove + gap / 2n;
}

/** Inside a pgTx: row-lock the tail position row and return max + 1024.
 *  Returns 1024n when the refTable has no positioned rows yet.
 *  Two concurrent callers serialize at the Postgres row lock. */
export async function nextPosition(
  tx: { get: <T>(sql: string, params?: unknown[]) => Promise<T | null> },
  dimTable: string,
): Promise<bigint> {
  const tail = await tx.get<{ position: string | null }>(
    `SELECT position
       FROM ${cq(dimTable)}
       WHERE position IS NOT NULL
       ORDER BY position DESC
       LIMIT 1
       FOR UPDATE`,
  );
  const max = tail?.position == null ? 0n : BigInt(tail.position);
  return max + 1024n;
}

/** Qualified source — (database_id, schema, table, column). The only source
 *  registration shape; callers handing in a bare "schema.table" string must
 *  resolve it to a databaseId themselves (see resolveDefaultDatabase below). */
export type QualifiedSource = {
  databaseId: string;
  schemaName: string;
  tableName: string;
  columnName: string;
};

/** Pick the tenant's default warehouse database: the first one registered.
 *  Used by internal helpers that take bare "schema.table" strings (seed,
 *  deriveRecord) and need to land a row in reference_table_source. Throws if
 *  the tenant has no warehouse_database registered. */
export async function resolveDefaultDatabase(tenantId: string): Promise<string> {
  void tenantId; // warehouse_database is deployment-global, not tenant-scoped
  const row = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."warehouse_database" ORDER BY added_at LIMIT 1`,
  );
  if (!row) {
    throw new AppError(
      "VALIDATION_FAILED",
      "no warehouse database registered; cannot resolve bare schema.table source",
      422,
    );
  }
  return row.id;
}

/** Remove a single wired source column from a refTable. Idempotent, but says
 *  which it was: `true` when a wiring was deleted, `false` when nothing
 *  matched — the caller must not claim a removal that never happened. */
export async function removeSource(
  refTableId: string,
  source: QualifiedSource,
  tenantId: string,
): Promise<boolean> {
  const deleted = await pgAll<{ ok: number }>(
    `DELETE FROM ${pg("reference_table_source")}
      WHERE tenant_id = $1 AND reference_table_id = $2 AND database_id = $3
        AND schema_name = $4 AND table_name = $5 AND column_name = $6
      RETURNING 1 AS ok`,
    [
      tenantId,
      refTableId,
      source.databaseId,
      source.schemaName,
      source.tableName,
      source.columnName,
    ],
  );
  return deleted.length > 0;
}

/** TxHelpers shape from pg.ts — duplicated locally to keep the type narrow. */
type TxLike = {
  all: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  get: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T | null>;
  run: (q: string, p?: unknown[]) => Promise<void>;
};

interface CurrentVersionRow {
  version: number;
  updated_at: Date;
  updated_by: string;
  name: string | null;
  initials: string | null;
}

interface ConflictCurrent {
  version: number;
  updatedAt: string;
  updatedBy: { id: string; name: string; initials: string };
}

/** Inside an existing pgTx, attempt to bump the version row for (reference_table_id, key).
 *  On success: returns the new version.
 *  On expected-version mismatch: throws AppError CONFLICT with details.current. */
async function bumpVersionOrThrow(
  tx: TxLike,
  refTableId: string,
  key: string,
  expectedVersion: number,
  userId: string,
  tenantId: string,
  meta: RefTableBasics,
): Promise<number> {
  const rows = await tx.all<{ version: number }>(
    `UPDATE "zugzug_app"."record_version"
        SET version = version + 1, updated_at = now(), updated_by = $1
      WHERE reference_table_id = $2 AND key = $3 AND version = $4 AND tenant_id = $5
        AND retired_at IS NULL
    RETURNING version`,
    [userId, refTableId, key, expectedVersion, tenantId],
  );
  if (rows.length === 1) return rows[0]!.version;

  const cur = await tx.get<CurrentVersionRow>(
    `SELECT cv.version, cv.updated_at, cv.updated_by,
            u.name, u.initials
       FROM "zugzug_app"."record_version" cv
       LEFT JOIN "zugzug_app"."users" u ON u.id = cv.updated_by
      WHERE cv.reference_table_id = $1 AND cv.key = $2 AND cv.tenant_id = $3
        AND cv.retired_at IS NULL`,
    [refTableId, key, tenantId],
  );
  if (!cur) {
    // No version row exists. Rows created by the bulk derive/seed paths
    // (deriveRecord, addRecord) never got one, so the read path reports
    // them as version 1. If the record row actually exists and the client is
    // at that implied v1, lazily seed the version row and bump it (to 2) rather
    // than 404. This backfills legacy rows on their first edit. Any other
    // expectedVersion for a row with no version row is a genuine mismatch.
    const exists = await tx.get<{ one: number }>(
      `SELECT 1 AS one FROM ${cq(meta.dimTable)} WHERE ${qid(meta.keyCol)} = $1`,
      [key],
    );
    if (exists && expectedVersion === 1) {
      const seeded = await tx.all<{ version: number }>(
        `INSERT INTO "zugzug_app"."record_version"
              (reference_table_id, key, version, updated_at, updated_by, tenant_id)
         VALUES ($1, $2, 2, now(), $3, $4)
         ON CONFLICT (tenant_id, reference_table_id, key) DO UPDATE
            SET version      = "record_version".version + 1,
                updated_at   = now(),
                updated_by   = EXCLUDED.updated_by,
                retired_at   = NULL,
                retired_into = NULL
         RETURNING version`,
        [refTableId, key, userId, tenantId],
      );
      if (seeded.length === 1) return seeded[0]!.version;
    }
    throw new AppError("NOT_FOUND", `record ${refTableId}/${key} not found`, 404);
  }

  const current: ConflictCurrent = {
    version: cur.version,
    updatedAt: cur.updated_at.toISOString(),
    updatedBy: {
      id: cur.updated_by,
      name: cur.name ?? cur.updated_by,
      initials: cur.initials ?? "??",
    },
  };
  throw new AppError("CONFLICT", "Record was modified by another user", 409, { current });
}

/** New record → version row at version=1 owned by userId. Use inside an existing tx. */
async function seedVersionRow(
  tx: TxLike,
  refTableId: string,
  key: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  await tx.run(
    `INSERT INTO "zugzug_app"."record_version" (reference_table_id, key, version, updated_at, updated_by, tenant_id)
     VALUES ($1, $2, 1, now(), $3, $4)
     ON CONFLICT (tenant_id, reference_table_id, key) DO UPDATE
        SET retired_at  = NULL,
            retired_into = NULL,
            version     = "record_version".version + 1,
            updated_at  = now(),
            updated_by  = EXCLUDED.updated_by`,
    [refTableId, key, userId, tenantId],
  );
}

/** Mark the record as edited without bumping its version: the row's *values*
 *  are untouched, so nobody's in-flight edit is invalidated, but the stamp puts
 *  the key into "changed since the last publish" (ADR-0002) so a manual reorder
 *  can be published. */
async function touchVersionRow(
  tx: TxLike,
  refTableId: string,
  key: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  await tx.run(
    `INSERT INTO "zugzug_app"."record_version" (reference_table_id, key, version, updated_at, updated_by, tenant_id)
     VALUES ($1, $2, 1, now(), $3, $4)
     ON CONFLICT (tenant_id, reference_table_id, key) DO UPDATE
        SET updated_at = now(),
            updated_by = EXCLUDED.updated_by`,
    [refTableId, key, userId, tenantId],
  );
}

/** Soft-retire the version row: set retired_at, leave retired_into NULL (no merge target). */
async function softRetireVersionRow(
  tx: TxLike,
  refTableId: string,
  key: string,
  tenantId: string,
): Promise<void> {
  await tx.run(
    `UPDATE "zugzug_app"."record_version"
        SET retired_at = now(), retired_into = NULL
      WHERE reference_table_id = $1 AND key = $2 AND tenant_id = $3`,
    [refTableId, key, tenantId],
  );
}

// types must be valid in BOTH DuckDB and the attached Postgres (DDL is forwarded
// to PG): Postgres has no DOUBLE, so number → NUMERIC.
const SQL_TYPE: Record<string, string> = {
  text: "VARCHAR",
  number: "NUMERIC",
  boolean: "BOOLEAN",
  date: "DATE",
  url: "VARCHAR",
  email: "VARCHAR",
  rating: "INTEGER",
  linked: "VARCHAR",
};

/* ---- refTable registry (Postgres) + record tables ---- */
export async function listRefTables(tenantId: string): Promise<RefTableMeta[]> {
  const metas = await pgAll<Omit<RefTableMeta, "rows">>(
    `SELECT id, label AS "refTable", dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("reference_table")} WHERE tenant_id = $1 ORDER BY label`,
    [tenantId],
  );
  // One UNION ALL round-trip for every map_<table> count instead of N+1
  // per-table pgGet calls on the boot path (#153). Table names come from the
  // trusted refTable registry (never user input), same as the per-table path.
  const byId = new Map<string, number>();
  if (metas.length > 0) {
    const sql = metas
      .map((m, i) => `SELECT $${i + 1}::text AS id, count(*)::int AS n FROM ${cq(m.mapTable)}`)
      .join(" UNION ALL ");
    try {
      const counts = await pgAll<{ id: string; n: number }>(
        sql,
        metas.map((m) => m.id),
      );
      for (const c of counts) byId.set(c.id, Number(c.n));
    } catch {
      // A missing map_<table> (corruption / mid-migration) would fail the whole
      // UNION — fall back to the resilient per-table path so one bad table
      // doesn't zero out the rest.
      const counts = await Promise.all(
        metas.map((m) =>
          pgGet<{ n: number }>(`SELECT count(*)::int AS n FROM ${cq(m.mapTable)}`).catch(
            () => null,
          ),
        ),
      );
      metas.forEach((m, i) => byId.set(m.id, Number(counts[i]?.n ?? 0)));
    }
  }

  return metas.map((m) => ({ ...m, rows: byId.get(m.id) ?? 0 }));
}

/** Lightweight refTable lookup — id + display label only, scoped to tenant.
 *  Used where the full record materialization in `getRefTable` is overkill
 *  (e.g. the AI suggestion workflow that just needs the refTable name). */
export async function getRefTableBasic(
  id: string,
  tenantId: string,
): Promise<{ id: string; label: string } | null> {
  const row = await pgGet<{ id: string; label: string }>(
    `SELECT id, label FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [id, tenantId],
  );
  return row ?? null;
}

/** Sample of existing record labels for a refTable, scoped to tenant.
 *  Reads the dynamic `dim_*` table whose name lives in the refTable registry. */
export async function getRecordValues(
  refTableId: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 1000));
  const meta = await pgGet<{ dimTable: string }>(
    `SELECT dim_table AS "dimTable" FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!meta) return [];
  const rows = await pgAll<{ label: string }>(
    `SELECT DISTINCT label FROM ${cq(meta.dimTable)}
     WHERE label IS NOT NULL ORDER BY label ASC LIMIT ${limit}`,
  ).catch(() => [] as { label: string }[]);
  return rows.map((r) => r.label);
}

export async function getRefTable(
  id: string,
  tenantId: string,
  opts?: { scalars?: SourceScanScalars[] },
): Promise<MappingRefTable | null> {
  const meta = await pgGet<
    Omit<RefTableMeta, "rows"> & {
      nameTable: string | null;
      nameIdCol: string | null;
      nameCol: string | null;
      description: string | null;
      color: string | null;
      ownerUserId: string | null;
      ownerName: string | null;
      orderingMode: string;
    }
  >(
    `SELECT refTable.id, refTable.label AS "refTable", refTable.dim_table AS "dimTable", refTable.map_table AS "mapTable",
            refTable.key_col AS "keyCol", COALESCE(refTable.key_kind, 'slug') AS "keyKind",
            refTable.name_table AS "nameTable", refTable.name_id_col AS "nameIdCol", refTable.name_col AS "nameCol",
            refTable.description, refTable.color, refTable.owner_user_id AS "ownerUserId", u.name AS "ownerName",
            COALESCE(refTable.ordering_mode, 'derived') AS "orderingMode"
     FROM ${pg("reference_table")} refTable
     LEFT JOIN ${pg("users")} u ON u.id = refTable.owner_user_id
     WHERE refTable.id = $1 AND refTable.tenant_id = $2`,
    [id, tenantId],
  );
  if (!meta) return null;

  const k = qid(meta.keyCol);
  const fields = await listFields(id, tenantId);
  // Formula fields have no physical column — they must stay out of the SQL and
  // are computed per row below.
  const scalarFields = fields.filter((f) => f.type !== "linked" && f.type !== "formula");
  const linkedFields = fields.filter((f) => f.type === "linked");
  const formulaFields = fields.filter((f) => f.type === "formula");

  // Pre-fetch target refTable metadata for each linked field (needed for JOIN)
  const linkedMetas = new Map<string, { keyCol: string; dimTable: string }>();
  for (const lf of linkedFields) {
    if (lf.referencedRefTableId) {
      const tm = await refTableMeta(lf.referencedRefTableId, tenantId);
      if (tm) linkedMetas.set(lf.field, tm);
    }
  }

  const scalarCols = scalarFields.map(
    (f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`,
  );
  const linkedFkCols = linkedFields.map(
    (f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`,
  );
  const lookupCols = linkedFields.flatMap((f) => {
    const tm = linkedMetas.get(f.field);
    if (!tm) return [];
    return (f.displayFields ?? ["label"]).map(
      (df) => `CAST(t_${f.field}.${qid(df)} AS VARCHAR) AS ${qid(`${f.field}__${df}`)}`,
    );
  });
  const fieldCols = [...scalarCols, ...linkedFkCols, ...lookupCols].join(", ");

  // LEFT JOIN clauses for linked fields
  const joins = linkedFields
    .map((lf) => {
      const tm = linkedMetas.get(lf.field);
      if (!tm) return "";
      return `LEFT JOIN ${cq(tm.dimTable)} t_${lf.field} ON d.${qid(lf.field)} = t_${lf.field}.${qid(tm.keyCol)}`;
    })
    .filter(Boolean)
    .join(" ");

  const liveName =
    meta.keyKind === "external_id" &&
    env.attachWarehouse &&
    !!meta.nameTable &&
    !!meta.nameIdCol &&
    !!meta.nameCol;

  const orderBy =
    meta.orderingMode === "manual"
      ? `ORDER BY d.position ASC NULLS LAST, variants DESC, ${meta.keyKind === "external_id" ? `d.${qid(meta.keyCol)}` : "d.label"}`
      : `ORDER BY variants DESC, ${meta.keyKind === "external_id" ? `d.${qid(meta.keyCol)}` : "d.label"}`;

  // Fetch record rows from Postgres
  let canonRows: Record<string, unknown>[];
  if (meta.keyKind === "external_id") {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, NULL AS label, true AS unresolved, d.position${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       ${joins}
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ${orderBy}`,
    );
  } else {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, d.label, false AS unresolved, d.position${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       ${joins}
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ${orderBy}`,
    );
  }

  // For external_id refTables with warehouse attached: resolve names from MotherDuck
  if (liveName) {
    const nameRef = await refForRegisteredTable(id, meta.nameTable!, tenantId);
    if (nameRef) {
      const adapter = await getAdapter();
      const nameMap = await adapter
        .nameResolution(nameRef, meta.nameIdCol!, meta.nameCol!)
        .catch(() => new Map<string, string>());
      for (const r of canonRows) {
        const key = String(r.key);
        r.label = nameMap.get(key) ?? null;
        r.unresolved = !nameMap.has(key);
      }
    }
  }

  const allFieldKeys = [
    ...scalarFields.map((f) => f.field),
    ...linkedFields.map((f) => f.field),
    ...linkedFields.flatMap((f) => (f.displayFields ?? ["label"]).map((df) => `${f.field}__${df}`)),
  ];

  // Without this the client can't supply the right expectedVersion and every
  // second rename of a record 409s against the optimistic-concurrency check.
  const versionRows = await pgAll<{ key: string; version: number }>(
    `SELECT key, version FROM ${pg("record_version")} WHERE reference_table_id = $1 AND tenant_id = $2 AND retired_at IS NULL`,
    [id, tenantId],
  );
  const versions = new Map(versionRows.map((r) => [r.key, Number(r.version)]));

  const record = canonRows.map((r) => {
    const fieldsMap: Record<string, string | null> = Object.fromEntries(
      allFieldKeys.map((fk) => [fk, r[fk] == null ? null : String(r[fk])]),
    );
    const base = {
      key: String(r.key),
      label: r.label == null ? String(r.key) : String(r.label),
      version: versions.get(String(r.key)) ?? 1,
      unresolved: !!r.unresolved,
      variants: Number(r.variants),
      position: r.position == null ? null : String(r.position as string | bigint),
      fields: fieldsMap,
    };
    if (formulaFields.length === 0) return base;
    // Evaluate formulas per row against a label-keyed view of this record's
    // stored fields (plus the built-ins key/label/variants). Formula columns
    // may only reference stored fields, so they are not in scope here.
    const evalRow: Record<string, unknown> = {
      key: base.key,
      label: base.label,
      variants: base.variants,
    };
    for (const sf of scalarFields) evalRow[sf.label] = fieldsMap[sf.field];
    const errors: Record<string, string> = {};
    for (const ff of formulaFields) {
      if (!ff.formula) {
        fieldsMap[ff.field] = null;
        continue;
      }
      const result = coerceToResultType(
        runFormula(ff.formula.expr, evalRow),
        ff.formula.resultType,
      );
      if (isFormulaError(result)) {
        fieldsMap[ff.field] = null;
        errors[ff.field] = result.message;
      } else {
        fieldsMap[ff.field] = result === null ? null : String(result);
      }
    }
    return Object.keys(errors).length > 0 ? { ...base, formulaErrors: errors } : base;
  });

  const rowsRow = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(meta.mapTable)}`,
  ).catch(() => null);
  const scalars = opts?.scalars ?? (await getSourceScanScalars(tenantId));
  const my = scalars.find((s) => s.refTableId === id);
  const counts = {
    newCount: my?.newCount ?? 0,
    mappedCount: my?.mappedCount ?? 0,
    totalDistinct: my?.totalDistinct ?? 0,
    unmappedRowsTotal: my?.unmappedRowsTotal ?? 0,
    mappedRowsTotal: my?.mappedRowsTotal ?? 0,
    scannedAt: my?.scannedAt ? my.scannedAt.toISOString() : null,
  };

  let nextPos: string | null = null;
  if (meta.orderingMode === "manual") {
    const tail = await pgGet<{ p: string | null }>(
      `SELECT MAX(position)::text AS p FROM ${cq(meta.dimTable)}`,
    ).catch(() => null);
    nextPos = tail?.p == null ? "1024" : String(BigInt(tail.p) + 1024n);
  }

  const {
    nameTable: _nameTable,
    nameIdCol: _nameIdCol,
    nameCol: _nameCol,
    description,
    color,
    ownerUserId,
    ownerName,
    orderingMode,
    ...metaOut
  } = meta;
  const safeColor =
    typeof color === "string" && (PALETTE_NAMES as readonly string[]).includes(color)
      ? (color as PaletteName)
      : null;
  return {
    ...metaOut,
    orderingMode,
    description: description ?? null,
    color: safeColor,
    ownerUserId: ownerUserId ?? null,
    ownerName: ownerName ?? null,
    rows: Number(rowsRow?.n ?? 0),
    nextPosition: nextPos,
    record,
    counts,
    fields,
  };
}

/** Create a refTable: register it + provision dim_/map_ (Postgres). Idempotent
 *  on the id. For key_kind 'external_id' the dim_ label is nullable (names are
 *  resolved live from the warehouse, not stored). Source bindings are added
 *  separately via addSource() / reference_table_source inserts. */
export async function addRefTable(
  name: string,
  sources: QualifiedSource[] = [],
  opts: { keyKind?: "slug" | "external_id"; silent?: boolean } = {},
  userId: string,
  tenantId: string,
): Promise<string> {
  const id = slug(name);
  if (!id) return id;
  const keyKind = opts.keyKind === "external_id" ? "external_id" : "slug";
  const dimTable = `${env.recordSchema}.dim_${id}`;
  const mapTable = `${env.recordSchema}.map_${id}`;
  const keyCol = `${id}_code`;
  // RefTable ids are globally unique (see 0011_mt_data_foundation.sql "DECISION
  // (refTable identity)"); a same-named refTable in two tenants would collide here.
  // Existence check stays unscoped so we don't double-create the dim_/map_
  // tables, but the INSERT below carries tenant_id so the refTable row is
  // owned by the calling tenant.
  const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$/;
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`addRefTable: invalid tenant_id ${tenantId}`);
  }
  const tenantLit = `'${tenantId}'`;
  const existing = await pgGet(`SELECT id FROM ${pg("reference_table")} WHERE id = $1`, [id]);
  if (!existing) {
    const labelDdl = keyKind === "external_id" ? "label VARCHAR" : "label VARCHAR NOT NULL";
    await pgRun(
      `CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (
         ${qid(keyCol)} VARCHAR PRIMARY KEY,
         ${labelDdl},
         position BIGINT,
         tenant_id VARCHAR NOT NULL DEFAULT ${tenantLit}
       )`,
    );
    await pgRun(
      `CREATE INDEX IF NOT EXISTS ${qid(`dim_${id}_position_idx`)}
         ON ${cq(dimTable)} (position) WHERE position IS NOT NULL`,
    );
    await pgRun(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${qid(`dim_${id}_position_uniq`)}
         ON ${cq(dimTable)} (position) WHERE position IS NOT NULL`,
    );
    await pgRun(
      `CREATE TABLE IF NOT EXISTS ${cq(mapTable)} (
         raw VARCHAR PRIMARY KEY,
         ${qid(keyCol)} VARCHAR NOT NULL,
         tenant_id VARCHAR NOT NULL DEFAULT ${tenantLit}
       )`,
    );
    await pgRun(
      `INSERT INTO ${pg("reference_table")} (id, label, dim_table, map_table, key_col, key_kind, created_at, owner_user_id, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, $7, $8)`,
      [id, name.trim(), dimTable, mapTable, keyCol, keyKind, userId, tenantId],
    );
    if (!opts.silent) {
      await appendAuditAs(
        userId,
        "Created refTable",
        `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`,
        { tenantId },
      );
    }
  }
  for (const s of sources) {
    await pgRun(
      `INSERT INTO ${pg("reference_table_source")} (reference_table_id, tenant_id, database_id, schema_name, table_name, column_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
      [id, tenantId, s.databaseId, s.schemaName, s.tableName, s.columnName],
    );
  }
  return id;
}

/** Seed record values into a refTable's dim_ table (idempotent). */
export async function addRecord(
  refTableId: string,
  values: RecordValue[],
  tenantId: string,
): Promise<void> {
  const meta = await refTableMeta(refTableId, tenantId);
  if (!meta) return;
  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (refTable ids are globally unique → effectively
  // per-tenant via the refTable registry's WHERE tenant_id = $N gate above).
  if (meta.orderingMode === "manual") {
    await pgTx(async (tx) => {
      const startPos = await nextPosition(tx, meta.dimTable);
      let localIdx = 0;
      for (const v of values) {
        const inserted = await tx.get<{ k: string }>(
          `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label, position) VALUES ($1, $2, $3)
           ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING
           RETURNING ${qid(meta.keyCol)} AS k`,
          [v.key, v.label, String(startPos + BigInt(localIdx) * 1024n)],
        );
        if (inserted) localIdx++;
      }
    });
  } else {
    for (const v of values) {
      await pgRun(
        `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label) VALUES ($1, $2)
         ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING`,
        [v.key, v.label],
      );
    }
  }
}

/** Message for an add that collides with a record already in the table. */
function duplicateKeyMessage(key: string): string {
  return `A record with the key "${key}" already exists.`;
}

/** Add one record record (key derived from the label if not given). */
export async function addRecordOne(
  refTableId: string,
  label: string,
  key: string | undefined,
  userId: string,
  tenantId: string,
): Promise<void> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return;
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (refTable ids are globally unique → effectively
  // per-tenant via the refTable registry's WHERE tenant_id = $N gate above).
  await pgTx(async (tx) => {
    let inserted: { k: string } | null | undefined;
    if (m.orderingMode === "manual") {
      const pos = await nextPosition(tx, m.dimTable);
      inserted = await tx.get<{ k: string }>(
        `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label, position) VALUES ($1, $2, $3)
         ON CONFLICT (${qid(m.keyCol)}) DO NOTHING
         RETURNING ${qid(m.keyCol)} AS k`,
        [k, label, String(pos)],
      );
    } else {
      inserted = await tx.get<{ k: string }>(
        `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
         ON CONFLICT (${qid(m.keyCol)}) DO NOTHING
         RETURNING ${qid(m.keyCol)} AS k`,
        [k, label],
      );
    }
    // Nothing inserted = the key is taken. Seeding the version row here would
    // bump the *existing* record's version (409-ing everyone else's in-flight
    // edits) for an add that never happened, so refuse instead.
    if (!inserted) throw new AppError("ALREADY_EXISTS", duplicateKeyMessage(k), 409);
    await seedVersionRow(tx, refTableId, k, userId, tenantId);
  });
  await appendAuditAs(userId, "Added record", `${label} (${k})`, {
    tableId: refTableId,
    rowKey: k,
    tenantId,
  });
}

export interface ImportRow {
  key?: string;
  label?: string;
  fields?: Record<string, string | null>;
}

/** Bulk CSV import. New keys are created (with label + field values); existing
 *  keys get field-value updates only — labels are never renamed here, so the
 *  optimistic-concurrency version machinery stays out of the bulk path. */
export async function importRecord(
  refTableId: string,
  rows: ImportRow[],
  userId: string,
  tenantId: string,
  opts: { silent?: boolean } = {},
): Promise<{ created: number; updated: number; skipped: number }> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) throw new AppError("NOT_FOUND", `refTable ${refTableId} not found`, 404);
  const defs = await listFields(refTableId, tenantId);
  const validFields = new Set(defs.map((f) => f.field));
  const existing = new Set(
    (await pgAll<{ k: string }>(`SELECT ${qid(m.keyCol)} AS k FROM ${cq(m.dimTable)}`)).map((r) =>
      String(r.k),
    ),
  );
  let created = 0,
    updated = 0,
    skipped = 0;
  if (m.orderingMode === "manual") {
    const fieldUpdates: Array<{ key: string; entries: [string, string | null][] }> = [];

    await pgTx(async (tx) => {
      const startPos = await nextPosition(tx, m.dimTable);
      let localIdx = 0;

      for (const row of rows) {
        const label = row.label?.trim() ?? "";
        // Keys are preserved verbatim (they may be external warehouse IDs);
        // only label-derived keys go through slug().
        const key = row.key?.trim() || (label ? slug(label) : "");
        if (!key) {
          skipped++;
          continue;
        }
        const fieldEntries = Object.entries(row.fields ?? {}).filter(([f]) =>
          validFields.has(f),
        ) as [string, string | null][];

        if (existing.has(key)) {
          if (fieldEntries.length === 0) {
            skipped++;
            continue;
          }
          fieldUpdates.push({ key, entries: fieldEntries });
          updated++;
        } else {
          if (!label) {
            skipped++;
            continue;
          }
          const pos = startPos + BigInt(localIdx) * 1024n;
          const inserted = await tx.get<{ k: string }>(
            `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label, position) VALUES ($1, $2, $3)
             ON CONFLICT (${qid(m.keyCol)}) DO NOTHING
             RETURNING ${qid(m.keyCol)} AS k`,
            [key, label, String(pos)],
          );
          if (inserted) {
            await seedVersionRow(tx, refTableId, key, userId, tenantId);
            existing.add(key);
            localIdx++;
            created++;
            if (fieldEntries.length > 0) {
              fieldUpdates.push({ key, entries: fieldEntries });
            }
          } else {
            skipped++;
          }
        }
      }
    });

    // Apply field updates outside the tx (pgRun is fine here)
    for (const { key, entries } of fieldUpdates) {
      for (const [f, v] of entries)
        await setFieldValue(refTableId, key, f, v, userId, tenantId, { silent: true });
    }
  } else {
    for (const row of rows) {
      const label = row.label?.trim() ?? "";
      // Keys are preserved verbatim (they may be external warehouse IDs);
      // only label-derived keys go through slug().
      const key = row.key?.trim() || (label ? slug(label) : "");
      if (!key) {
        skipped++;
        continue;
      }
      const fieldEntries = Object.entries(row.fields ?? {}).filter(([f]) => validFields.has(f));
      if (existing.has(key)) {
        if (fieldEntries.length === 0) {
          skipped++;
          continue;
        }
        for (const [f, v] of fieldEntries)
          await setFieldValue(refTableId, key, f, v, userId, tenantId, { silent: true });
        updated++;
      } else {
        if (!label) {
          skipped++;
          continue;
        }
        await pgTx(async (tx) => {
          await tx.run(
            `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
             ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
            [key, label],
          );
          await seedVersionRow(tx, refTableId, key, userId, tenantId);
        });
        for (const [f, v] of fieldEntries)
          await setFieldValue(refTableId, key, f, v, userId, tenantId, { silent: true });
        existing.add(key);
        created++;
      }
    }
  }
  if (!opts.silent) {
    await appendAuditAs(
      userId,
      "Imported CSV",
      `${created} created · ${updated} updated · ${skipped} skipped`,
      { tableId: refTableId, tenantId },
    );
  }
  return { created, updated, skipped };
}

/** Rename a record's display label (the key is stable). */
export async function renameRecord(
  refTableId: string,
  key: string,
  label: string,
  userId: string,
  expectedVersion: number,
  tenantId: string,
): Promise<{ version: number }> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) throw new AppError("NOT_FOUND", `refTable ${refTableId} not found`, 404);

  // Fetch old label before overwriting — needed for ai_hint_cache sync below.
  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (refTable ids are globally unique → effectively
  // per-tenant via the refTable registry's WHERE tenant_id = $N gate above).
  const oldRow = await pgGet<{ label: string }>(
    `SELECT label FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  ).catch(() => null);

  const newVersion = await pgTx(async (tx) => {
    const v = await bumpVersionOrThrow(tx, refTableId, key, expectedVersion, userId, tenantId, m);
    await tx.run(`UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`, [
      label,
      key,
    ]);
    return v;
  });

  await appendAuditAs(userId, "Renamed record", `${key} → "${label}"`, {
    tableId: refTableId,
    rowKey: key,
    tenantId,
    metadata: { field: "label", label: "Name", before: oldRow?.label ?? null, after: label },
  });

  // Keep ai_hint_cache consistent: update any hint that was pointing at the old label.
  if (oldRow?.label) {
    await pgRun(
      `UPDATE ${pg("ai_hint_cache")} SET suggestion = $1
       WHERE reference_table_id = $2 AND suggestion = $3 AND tenant_id = $4`,
      [label, refTableId, oldRow.label, tenantId],
    ).catch(() => {
      /* table may not exist in older deploys */
    });
  }

  return { version: newVersion };
}

/** Merge loser records into a survivor: re-point every crosswalk row, drop the
 *  losers' golden records, audit. The core MDM consolidation step. */
export async function mergeRecord(
  refTableId: string,
  survivor: string,
  losers: string[],
  userId: string,
  expectedVersions: Record<string, number>,
  tenantId: string,
): Promise<number> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return 0;
  const key = qid(m.keyCol);
  const real = losers.filter((l) => l && l !== survivor);
  if (real.length === 0) return 0;

  const allKeys = [survivor, ...real];

  await pgTx(async (tx) => {
    // Bulk version-bump via VALUES list. Returns the set of keys actually bumped.
    // We compare against allKeys to detect stale-version misses.
    const valuesSql = allKeys.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3}::int)`).join(", ");
    const params: unknown[] = [userId];
    for (const k of allKeys) {
      params.push(k, expectedVersions[k] ?? -1);
    }
    const bumped = await tx.all<{ key: string }>(
      `WITH expected(key, expected_version) AS (
         VALUES ${valuesSql}
       )
       UPDATE "zugzug_app"."record_version" cv
          SET version = cv.version + 1, updated_at = now(), updated_by = $1
         FROM expected e
        WHERE cv.reference_table_id = '${refTableId.replace(/'/g, "''")}'
          AND cv.tenant_id = '${tenantId.replace(/'/g, "''")}'
          AND cv.key = e.key
          AND cv.version = e.expected_version
          AND cv.retired_at IS NULL
       RETURNING cv.key`,
      params,
    );
    const bumpedSet = new Set(bumped.map((b) => b.key));
    const missed = allKeys.filter((k) => !bumpedSet.has(k));
    if (missed.length > 0) {
      const cur = await tx.get<{
        version: number;
        updated_at: Date;
        updated_by: string;
        name: string | null;
        initials: string | null;
      }>(
        `SELECT cv.version, cv.updated_at, cv.updated_by, u.name, u.initials
           FROM "zugzug_app"."record_version" cv
           LEFT JOIN "zugzug_app"."users" u ON u.id = cv.updated_by
          WHERE cv.reference_table_id = $1 AND cv.key = $2 AND cv.tenant_id = $3
            AND cv.retired_at IS NULL`,
        [refTableId, missed[0]!, tenantId],
      );
      throw new AppError("CONFLICT", "One or more records were modified by another user", 409, {
        current: cur && {
          version: cur.version,
          updatedAt: cur.updated_at.toISOString(),
          updatedBy: {
            id: cur.updated_by,
            name: cur.name ?? cur.updated_by,
            initials: cur.initials ?? "??",
          },
        },
        conflictedKeys: missed,
      });
    }

    // All version checks passed — execute the merge.
    await tx.run(`UPDATE ${cq(m.mapTable)} SET ${key} = $1 WHERE ${key} = ANY($2::text[])`, [
      survivor,
      real,
    ]);
    await tx.run(`DELETE FROM ${cq(m.dimTable)} WHERE ${key} = ANY($1::text[])`, [real]);
    await tx.run(
      `UPDATE "zugzug_app"."record_version"
          SET retired_at = now(), retired_into = $4
        WHERE reference_table_id = $1 AND key = ANY($2::text[]) AND tenant_id = $3`,
      [refTableId, real, tenantId, survivor],
    );
  });

  await appendAuditAs(userId, "Merged record", `${real.join(", ")} → ${survivor}`, {
    tableId: refTableId,
    rowKey: survivor,
    tenantId,
  });
  return real.length;
}

/** Retire a record — governed: refused while raw variants still map to it. */
export async function retireRecord(
  refTableId: string,
  key: string,
  userId: string,
  expectedVersion: number,
  tenantId: string,
): Promise<{ ok: boolean; variants: number }> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return { ok: false, variants: 0 };

  // Variant check inside the tx so it sees the same snapshot as the delete —
  // closes the race where a concurrent map insert lands between the check and
  // the dim_X DELETE (map_X has no FK to dim_X, so the dangling reference would
  // not error). map_X gains no row lock from a SELECT, so a concurrent INSERT
  // after this read is still possible in READ COMMITTED — but the same tx then
  // executes the DELETE in the same snapshot, so we either see 0 variants and
  // delete cleanly, or see variants and refuse without bumping the version.
  const result = await pgTx<{ ok: boolean; variants: number }>(async (tx) => {
    const v = await tx.get<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1`,
      [key],
    );
    const variants = Number(v?.n ?? 0);
    if (variants > 0) return { ok: false, variants };

    await bumpVersionOrThrow(tx, refTableId, key, expectedVersion, userId, tenantId, m);

    // Read the label BEFORE the DELETE so the outbound event carries the
    // human-facing name as it existed at the time of retirement. Each refTable
    // has its own dim_<slug> table so (key) is the natural identifier here.
    const labelRow = await tx.get<{ label: string }>(
      `SELECT label FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`,
      [key],
    );

    await tx.run(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
    await softRetireVersionRow(tx, refTableId, key, tenantId);

    // Atomic outbound event — fails the tx if the INSERT does (design §3.1).
    const firedAt = new Date();
    await dispatchOutbound(tx, {
      tenantId,
      type: "record.deleted",
      refTableId,
      occurredAt: firedAt,
      payload: {
        table_slug: refTableId,
        key,
        label: labelRow?.label ?? key,
        deleted_by: { id: userId },
      },
      // Includes timestamp so concurrent retire calls of the same key (e.g.
      // re-add then re-retire) produce distinct idem keys.
      idemKey: `record.deleted:${refTableId}:${key}:${firedAt.getTime()}`,
    });

    return { ok: true, variants: 0 };
  });

  if (result.ok) {
    await appendAuditAs(userId, "Retired record", key, {
      tableId: refTableId,
      rowKey: key,
      tenantId,
    });
  }
  return result;
}

/* ---- enrichment fields (attribute columns on dim_) ---- */
export async function listFields(refTableId: string, tenantId: string): Promise<FieldDef[]> {
  const rows = await pgAll<{
    field: string;
    label: string;
    type: string;
    field_config: string | null;
    description: string | null;
  }>(
    `SELECT field, label, type, field_config, description FROM ${pg("reference_table_field")} WHERE reference_table_id = $1 AND tenant_id = $2 ORDER BY created_at`,
    [refTableId, tenantId],
  );
  return rows.map((r) => {
    const cfg = parseFieldConfig(r.type, r.field_config);
    return {
      field: r.field,
      label: r.label,
      type: r.type,
      ...cfg,
      description: r.description ?? undefined,
    };
  });
}

/** Update metadata on an existing field (description and/or field_config).
 *  When a key is undefined it is left unchanged; null clears it. */
export async function updateField(
  refTableId: string,
  field: string,
  updates: { description?: string | null; fieldConfig?: string | null },
  userId: string,
  tenantId: string,
): Promise<void> {
  if (updates.description === undefined && updates.fieldConfig === undefined) return;

  if (updates.description !== undefined) {
    const desc =
      typeof updates.description === "string"
        ? updates.description.trim() === ""
          ? null
          : updates.description.trim()
        : updates.description;
    await pgRun(
      `UPDATE ${pg("reference_table_field")} SET description = $1 WHERE reference_table_id = $2 AND field = $3 AND tenant_id = $4`,
      [desc, refTableId, field, tenantId],
    );
    await appendAuditAs(userId, "Updated field description", field, { tenantId });
  }

  if (updates.fieldConfig !== undefined) {
    // Read the existing field_config, parse it, shallow-merge with the incoming
    // JSON, then write back — so PATCHes with one key (e.g. rules) don't wipe
    // the rest of the column's config (options, numberFormat, ratingMax, …).
    const existing = await pgGet<{ field_config: string | null; type: string }>(
      `SELECT field_config, type FROM ${pg("reference_table_field")} WHERE reference_table_id = $1 AND field = $2 AND tenant_id = $3`,
      [refTableId, field, tenantId],
    );
    let currentCfg: Record<string, unknown> = {};
    if (existing?.field_config) {
      try {
        const parsed: unknown = JSON.parse(existing.field_config);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          currentCfg = parsed as Record<string, unknown>;
        }
      } catch {
        currentCfg = {};
      }
    }

    // Validate linked-field config keys BEFORE merging/writing.
    // We pre-parse the incoming payload here so we can reject bad inputs without
    // mutating the row. The main parse below builds `incomingCfg` for the merge.
    const incomingParsed: Record<string, unknown> = (() => {
      if (updates.fieldConfig == null) return {};
      try {
        const v: unknown = JSON.parse(updates.fieldConfig);
        return v !== null && typeof v === "object" && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })();

    if ("targetRefTableId" in incomingParsed) {
      const incomingTarget = String(incomingParsed.targetRefTableId ?? "");
      const currentTarget =
        typeof currentCfg.targetRefTableId === "string" ? currentCfg.targetRefTableId : "";
      if (currentTarget !== "" && incomingTarget !== "" && incomingTarget !== currentTarget) {
        throw new Error(
          "targetRefTableId is immutable after creation; delete and recreate the field",
        );
      }
    }

    // Re-validate an edited formula (syntax, known functions, existing field refs)
    // before it is merged in — a broken expression must never reach getRefTable.
    if (existing?.type === "formula" && "expr" in incomingParsed) {
      const expr = typeof incomingParsed.expr === "string" ? incomingParsed.expr : "";
      if (expr.trim() === "") throw new Error("A formula can't be empty.");
      const knownLabels = new Set<string>([
        "key",
        "label",
        "variants",
        ...(await listFields(refTableId, tenantId))
          .filter((e) => e.type !== "formula")
          .map((e) => e.label),
      ]);
      const v = validateFormula(expr, knownLabels);
      if (!v.ok) throw new Error(v.error ?? "Invalid formula.");
    }

    let beforeDisplayFields: string[] | null = null;
    let afterDisplayFields: string[] | null = null;
    if ("displayFields" in incomingParsed) {
      const incoming = incomingParsed.displayFields;
      if (!Array.isArray(incoming) || !incoming.every((v) => typeof v === "string")) {
        throw new Error("displayFields must be an array of strings");
      }
      if (!incoming.includes("label")) {
        throw new Error('displayFields must include "label"');
      }
      if (new Set(incoming).size !== incoming.length) {
        throw new Error("displayFields contains duplicate entries");
      }
      const targetRefTableId =
        (typeof currentCfg.targetRefTableId === "string" ? currentCfg.targetRefTableId : "") ||
        (typeof incomingParsed.targetRefTableId === "string"
          ? incomingParsed.targetRefTableId
          : "");
      if (targetRefTableId === "") {
        throw new Error("displayFields update requires a target refTable");
      }
      const targetFields = await pgAll<{ field: string }>(
        `SELECT field FROM ${pg("reference_table_field")} WHERE reference_table_id = $1 AND tenant_id = $2`,
        [targetRefTableId, tenantId],
      );
      const validFields = new Set(targetFields.map((r) => r.field));
      const priorList = Array.isArray(currentCfg.displayFields)
        ? (currentCfg.displayFields as unknown[]).filter((v): v is string => typeof v === "string")
        : ["label"];
      const priorSet = new Set(priorList);
      for (const entry of incoming) {
        if (entry === "label") continue;
        if (validFields.has(entry)) continue;
        if (priorSet.has(entry)) continue; // stale-but-already-stored: tolerate
        throw new Error(`displayFields entry not found on target refTable: ${entry}`);
      }
      beforeDisplayFields = priorList;
      afterDisplayFields = incoming;
    }

    let incomingCfg: Record<string, unknown> | null = null;
    if (typeof updates.fieldConfig === "string") {
      try {
        const parsed: unknown = JSON.parse(updates.fieldConfig);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          incomingCfg = parsed as Record<string, unknown>;
        }
      } catch {
        incomingCfg = null;
      }
    }
    const mergedConfig =
      incomingCfg !== null
        ? JSON.stringify({ ...currentCfg, ...incomingCfg })
        : updates.fieldConfig; // non-JSON or null — write raw (preserves clear semantics)
    await pgRun(
      `UPDATE ${pg("reference_table_field")} SET field_config = $1 WHERE reference_table_id = $2 AND field = $3 AND tenant_id = $4`,
      [mergedConfig, refTableId, field, tenantId],
    );
    if (incomingCfg !== null && "rules" in incomingCfg) {
      await appendAuditAs(userId, "Updated field rules", field, { tenantId });
    }
    if (beforeDisplayFields !== null && afterDisplayFields !== null) {
      await appendAuditAs(userId, "field.displayFields.update", field, {
        tableId: refTableId,
        tenantId,
        metadata: { before: beforeDisplayFields, after: afterDisplayFields },
      });
    }
  }
}

/** Add an attribute column to a refTable's dim_ table (ALTER TABLE). type ∈
 *  text | number | boolean | date | select | url | email | rating.
 *  Select columns store an ordered option list in `reference_table_field.field_config` (JSON);
 *  the dim_ column is VARCHAR (the value IS the option label).
 *  Rating columns store { ratingMax } in field_config. */
export async function addField(
  refTableId: string,
  label: string,
  type: string = "text",
  options: OptionDef[] | undefined,
  opts: {
    silent?: boolean;
    numberFormat?: NumberFormat;
    ratingMax?: number;
    referencedRefTableId?: string;
    displayFields?: string[];
    required?: boolean;
    validation?: { unique?: boolean; min?: number | string | null; max?: number | string | null };
    formula?: FormulaConfig;
  } = {},
  userId: string,
  tenantId: string,
): Promise<{ field: string } | null> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return null;
  const KNOWN = new Set([
    "text",
    "number",
    "boolean",
    "date",
    "select",
    "url",
    "email",
    "rating",
    "linked",
    "formula",
  ]);
  const t = KNOWN.has(type) ? type : "text";

  if (t === "linked") {
    if (!opts.referencedRefTableId) return null;
    const targetMeta = await refTableMeta(opts.referencedRefTableId, tenantId);
    if (!targetMeta) return null;
    const targetFieldNames = new Set(
      (await listFields(opts.referencedRefTableId, tenantId)).map((f) => f.field),
    );
    const dfs = opts.displayFields ?? ["label"];
    // "label" is always present on every dim_* table; validate any others
    if (!dfs.every((df) => df === "label" || targetFieldNames.has(df))) return null;
  }

  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null;
  const cfg: Record<string, unknown> = {};
  if (t === "formula") {
    // Computed column: validate the expression, then store it — but add NO
    // physical column (the value is computed on read, never stored).
    const f = opts.formula;
    if (!f || typeof f.expr !== "string" || f.expr.trim() === "") return null;
    const knownLabels = new Set<string>([
      "key",
      "label",
      "variants",
      ...(await listFields(refTableId, tenantId))
        .filter((e) => e.type !== "formula")
        .map((e) => e.label),
    ]);
    if (!validateFormula(f.expr, knownLabels).ok) return null;
    cfg.expr = f.expr.trim();
    cfg.resultType =
      f.resultType === "number" || f.resultType === "boolean" ? f.resultType : "text";
    if (cfg.resultType === "number" && f.numberFormat) cfg.numberFormat = f.numberFormat;
  } else {
    const sqlType = SQL_TYPE[t] ?? "VARCHAR";
    await pgRun(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
    if (t === "select") cfg.options = options ?? [];
    else if (t === "number" && opts.numberFormat != null) cfg.numberFormat = opts.numberFormat;
    else if (t === "rating") cfg.ratingMax = opts.ratingMax ?? 5;
    else if (t === "linked") {
      cfg.targetRefTableId = opts.referencedRefTableId;
      cfg.displayFields = opts.displayFields ?? ["label"];
    }
    if (opts.required) cfg.required = true;
    if (opts.validation && Object.keys(opts.validation).length > 0)
      cfg.validation = opts.validation;
  }
  const optsJson = Object.keys(cfg).length > 0 ? JSON.stringify(cfg) : null;
  await pgRun(
    `INSERT INTO ${pg("reference_table_field")} (reference_table_id, field, label, type, field_config, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, current_timestamp, $6) ON CONFLICT (tenant_id, reference_table_id, field) DO NOTHING`,
    [refTableId, field, label.trim(), t, optsJson, tenantId],
  );
  if (!opts.silent) {
    await appendAuditAs(userId, "Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`, {
      tenantId,
    });
  }
  return { field };
}

/** Dry-run a candidate formula for the field editor: check syntax + that every
 *  referenced field exists, then evaluate it against the table's first record so
 *  the author sees a real sample value. A row that errors (e.g. divide-by-zero)
 *  is a non-blocking `warning`, not an `error` — the formula itself is valid. */
export async function validateTableFormula(
  refTableId: string,
  expr: string,
  tenantId: string,
): Promise<{ ok: boolean; error?: string; warning?: string; sample?: string | null }> {
  const fields = await listFields(refTableId, tenantId);
  const knownLabels = new Set<string>([
    "key",
    "label",
    "variants",
    ...fields.filter((f) => f.type !== "formula").map((f) => f.label),
  ]);
  const v = validateFormula(expr, knownLabels);
  if (!v.ok) return { ok: false, error: v.error };

  const table = await getRefTable(refTableId, tenantId);
  const first = table?.record[0];
  if (!first) return { ok: true };
  const evalRow: Record<string, unknown> = {
    key: first.key,
    label: first.label,
    variants: first.variants ?? 0,
  };
  for (const sf of fields.filter((f) => f.type !== "linked" && f.type !== "formula")) {
    evalRow[sf.label] = first.fields?.[sf.field] ?? null;
  }
  const result = runFormula(expr, evalRow);
  if (isFormulaError(result)) return { ok: true, warning: result.message };
  return { ok: true, sample: result === null ? null : String(result) };
}

/** Labels of the formula columns in this table whose expression references
 *  `label`. Formulas address other columns by display label, so a rename or a
 *  delete silently breaks every formula that names the column. */
async function formulaColumnsReferencing(
  refTableId: string,
  label: string,
  tenantId: string,
): Promise<string[]> {
  const fields = await listFields(refTableId, tenantId);
  return fields
    .filter((f) => f.type === "formula" && f.formula != null)
    .filter((f) => validateFormula(f.formula!.expr).fieldRefs?.includes(label) === true)
    .map((f) => f.label);
}

/** Rename a column's display label. The `field` (stable id / DB column name)
 *  stays put; only `label` changes. */
export async function renameColumn(
  refTableId: string,
  field: string,
  newLabel: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  const current = (await listFields(refTableId, tenantId)).find((x) => x.field === field);
  if (current && current.label !== label) {
    const used = await formulaColumnsReferencing(refTableId, current.label, tenantId);
    if (used.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `"${current.label}" is used by the formula column ${used.map((u) => `"${u}"`).join(", ")} — update the formula first.`,
        422,
      );
    }
  }
  await pgRun(
    `UPDATE ${pg("reference_table_field")} SET label = $1 WHERE reference_table_id = $2 AND field = $3 AND tenant_id = $4`,
    [label, refTableId, field, tenantId],
  );
  await appendAuditAs(userId, "Renamed column", `${field} → "${label}"`, { tenantId });
}

/** The parts of a field_config that survive a type change: conditional rules
 *  and the required flag apply to every type; validation bounds and uniqueness
 *  are pruned to the types they mean anything for (same rule as the grid's
 *  pruneValidationForType). Type-specific keys (options / numberFormat /
 *  ratingMax / linked config) are the caller's to write. */
function carryOverFieldConfig(raw: string | null, newType: string): Record<string, unknown> {
  let cfg: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        cfg = parsed as Record<string, unknown>;
      }
    } catch {
      /* unparseable config — nothing to carry over */
    }
  }
  const out: Record<string, unknown> = {};
  if (Array.isArray(cfg.rules) && cfg.rules.length > 0) out.rules = cfg.rules;
  if (cfg.required === true) out.required = true;
  const v = cfg.validation;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const src = v as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    if (["number", "date", "text"].includes(newType)) {
      if (src.min !== undefined) kept.min = src.min;
      if (src.max !== undefined) kept.max = src.max;
    }
    if (src.unique === true && ["text", "number", "date", "url", "email"].includes(newType)) {
      kept.unique = true;
    }
    if (Object.keys(kept).length > 0) out.validation = kept;
  }
  return out;
}

/** Change a column's type. Validates that every existing cell value parses to
 *  the new type; returns { ok: false, invalidCount } when N cells would
 *  silently null. Caller decides whether to retry with coerceInvalidToNull. */
export async function changeColumnType(
  refTableId: string,
  field: string,
  opts: {
    newType: string;
    options?: OptionDef[];
    numberFormat?: NumberFormat;
    ratingMax?: number;
    coerceInvalidToNull: boolean;
    userId: string;
  },
  tenantId: string,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return { ok: false };
  const f = (await listFields(refTableId, tenantId)).find((x) => x.field === field);
  if (!f) return { ok: false };
  if (f.type === "linked" || opts.newType === "linked") return { ok: false };
  const col = qid(field);
  const keyc = qid(m.keyCol);
  const { newType, coerceInvalidToNull, userId } = opts;
  // Conditional formatting, the required flag and still-applicable validation
  // outlive a type change — read the stored config so both paths below merge
  // rather than overwrite.
  const priorCfg = await pgGet<{ field_config: string | null }>(
    `SELECT field_config FROM ${pg("reference_table_field")} WHERE reference_table_id = $1 AND field = $2 AND tenant_id = $3`,
    [refTableId, field, tenantId],
  );
  const carried = carryOverFieldConfig(priorCfg?.field_config ?? null, newType);
  const mergedConfig = (typeSpecific: Record<string, unknown> | null): string | null => {
    const merged = { ...carried, ...(typeSpecific ?? {}) };
    return Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
  };

  // VARCHAR relabels — only safe when current SQL type is already VARCHAR
  if (
    (newType === "url" || newType === "email") &&
    (f.type === "text" || f.type === "select" || f.type === "url" || f.type === "email")
  ) {
    await pgTx(async ({ run }) => {
      await run(
        `UPDATE ${pg("reference_table_field")} SET type = $1, field_config = $2 WHERE reference_table_id = $3 AND field = $4 AND tenant_id = $5`,
        [newType, mergedConfig(null), refTableId, field, tenantId],
      );
    });
    await appendAuditAs(userId, "Changed column type", `${field} → ${newType}`, { tenantId });
    return { ok: true };
  }

  const rows = await pgAll<{ k: string; v: string | null }>(
    `SELECT ${keyc} AS k, CAST(${col} AS VARCHAR) AS v FROM ${cq(m.dimTable)}`,
  );

  const parsed: { k: string; v: string | number | boolean | null; bad: boolean }[] = [];
  for (const r of rows) {
    if (r.v == null || r.v === "") {
      parsed.push({ k: r.k, v: null, bad: false });
      continue;
    }
    if (newType === "text") {
      parsed.push({ k: r.k, v: r.v, bad: false });
      continue;
    }
    if (newType === "select") {
      const collected: OptionDef[] =
        opts.options ??
        [...new Set(rows.filter((x) => x.v).map((x) => x.v!))].map((label) => ({
          label,
          color: null,
        }));
      const ok = collected.some((o) => o.label === r.v);
      parsed.push({ k: r.k, v: r.v, bad: !ok });
      continue;
    }
    if (newType === "url" || newType === "email") {
      // All existing values are valid VARCHAR — stringify whatever's there
      parsed.push({ k: r.k, v: r.v, bad: false });
      continue;
    }
    if (newType === "number") {
      const n = Number(r.v);
      parsed.push({ k: r.k, v: Number.isFinite(n) ? n : null, bad: !Number.isFinite(n) });
      continue;
    }
    if (newType === "boolean") {
      const b = r.v === "true" ? true : r.v === "false" ? false : null;
      parsed.push({ k: r.k, v: b, bad: b == null });
      continue;
    }
    if (newType === "date") {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(r.v);
      parsed.push({ k: r.k, v: ok ? r.v : null, bad: !ok });
      continue;
    }
    if (newType === "rating") {
      const max = opts.ratingMax ?? 5;
      if (r.v === "true") {
        parsed.push({ k: r.k, v: 1, bad: false });
        continue;
      }
      if (r.v === "false") {
        // boolean false → 0, which is out of range for 1-based rating → bad
        parsed.push({ k: r.k, v: null, bad: true });
        continue;
      }
      const n = Number(r.v);
      if (!Number.isFinite(n)) {
        parsed.push({ k: r.k, v: null, bad: true });
        continue;
      }
      const rounded = Math.round(n);
      if (rounded < 1 || rounded > max) {
        parsed.push({ k: r.k, v: null, bad: true });
        continue;
      }
      parsed.push({ k: r.k, v: rounded, bad: false });
      continue;
    }
    parsed.push({ k: r.k, v: r.v, bad: true });
  }

  const invalidCount = parsed.filter((p) => p.bad).length;
  if (invalidCount > 0 && !coerceInvalidToNull) return { ok: false, invalidCount };

  const newSql = SQL_TYPE[newType] ?? "VARCHAR";
  const tmp = `${field}__tmp_${Date.now().toString(36)}`;
  let finalOptions: OptionDef[] | undefined;
  if (newType === "select") {
    finalOptions =
      opts.options ??
      [...new Set(parsed.filter((p) => p.v != null).map((p) => String(p.v)))].map((label) => ({
        label,
        color: null,
      }));
  }

  await pgTx(async ({ run }) => {
    await run(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN ${qid(tmp)} ${newSql}`);
    for (const p of parsed) {
      if (p.bad && !coerceInvalidToNull) continue;
      await run(`UPDATE ${cq(m.dimTable)} SET ${qid(tmp)} = $1 WHERE ${keyc} = $2`, [p.v, p.k]);
    }
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN ${col}`);
    await run(`ALTER TABLE ${cq(m.dimTable)} RENAME COLUMN ${qid(tmp)} TO ${col}`);
    await run(
      `UPDATE ${pg("reference_table_field")} SET type = $1, field_config = $2 WHERE reference_table_id = $3 AND field = $4 AND tenant_id = $5`,
      [
        newType,
        mergedConfig(
          newType === "select"
            ? { options: finalOptions ?? [] }
            : newType === "number" && opts.numberFormat != null
              ? { numberFormat: opts.numberFormat }
              : newType === "rating"
                ? { ratingMax: opts.ratingMax ?? 5 }
                : null,
        ),
        refTableId,
        field,
        tenantId,
      ],
    );
  });

  await appendAuditAs(
    userId,
    "Changed column type",
    `${field} → ${newType}${finalOptions ? ` (${finalOptions.length} options)` : ""}`,
    { tenantId },
  );
  return { ok: true, options: finalOptions };
}

/** Drop a column from the dim_ table AND its row in reference_table_field, plus null
 *  the field on every row of the refTable. Transactional — all-or-nothing. */
export async function deleteColumn(
  refTableId: string,
  field: string,
  userId: string,
  tenantId: string,
): Promise<{ ok: boolean }> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return { ok: false };
  const target = (await listFields(refTableId, tenantId)).find((x) => x.field === field);
  if (target) {
    const used = await formulaColumnsReferencing(refTableId, target.label, tenantId);
    if (used.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `"${target.label}" is used by the formula column ${used.map((u) => `"${u}"`).join(", ")} — update the formula first.`,
        422,
      );
    }
  }
  const col = qid(field);
  await pgTx(async ({ all, run }) => {
    // Cascade: strip deleted field from displayFields of any linked fields in
    // this tenant (cross-tenant linked refs are impossible by construction).
    const linkedRefs = await all<{
      reference_table_id: string;
      field: string;
      field_config: string;
    }>(
      `SELECT reference_table_id, field, field_config FROM ${pg("reference_table_field")}
       WHERE type = 'linked'
       AND tenant_id = $3
       AND field_config::jsonb ->> 'targetRefTableId' = $1
       AND field_config::jsonb -> 'displayFields' ? $2`,
      [refTableId, field, tenantId],
    );
    for (const ref of linkedRefs) {
      const cfg = JSON.parse(ref.field_config) as {
        targetRefTableId: string;
        displayFields: string[];
      };
      const newDfs = cfg.displayFields.filter((df) => df !== field);
      await run(
        `UPDATE ${pg("reference_table_field")} SET field_config = $1 WHERE reference_table_id = $2 AND field = $3 AND tenant_id = $4`,
        [
          JSON.stringify({ ...cfg, displayFields: newDfs }),
          ref.reference_table_id,
          ref.field,
          tenantId,
        ],
      );
    }
    await run(
      `DELETE FROM ${pg("reference_table_field")} WHERE reference_table_id = $1 AND field = $2 AND tenant_id = $3`,
      [refTableId, field, tenantId],
    );
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN IF EXISTS ${col}`);
  });
  await appendAuditAs(userId, "Deleted column", field, { tenantId });
  return { ok: true };
}

/** Append a new option to a select column's options list. No-op if the option
 *  already exists (case-sensitive). Returns the resulting options list.
 *  Stored as a JSON string in a VARCHAR column — see drizzle/migrations/0000_baseline.sql for rationale. */
export async function addColumnOption(
  refTableId: string,
  field: string,
  label: string,
  color: PaletteName | null = null,
  opts: { silent?: boolean } = {},
  userId: string,
  tenantId: string,
): Promise<{ options: OptionDef[] } | null> {
  const f = (await listFields(refTableId, tenantId)).find((x) => x.field === field);
  if (!f || f.type !== "select") return null;
  const existing = f.options ?? [];
  if (existing.some((o) => o.label === label)) return { options: existing };
  const next: OptionDef[] = [...existing, { label, color }];
  // Preserve any other keys in field_config (e.g. rules) by reading the raw
  // stored value and merging only the options key.
  const rawRow = await pgGet<{ field_config: string | null }>(
    `SELECT field_config FROM ${pg("reference_table_field")} WHERE reference_table_id = $1 AND field = $2 AND tenant_id = $3`,
    [refTableId, field, tenantId],
  );
  let existingCfg: Record<string, unknown> = {};
  if (rawRow?.field_config) {
    try {
      const parsed: unknown = JSON.parse(rawRow.field_config);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingCfg = parsed as Record<string, unknown>;
      }
      // bare array: existingCfg stays {} — options come from `next` below
    } catch {
      /* ignore */
    }
  }
  await pgRun(
    `UPDATE ${pg("reference_table_field")} SET field_config = $1 WHERE reference_table_id = $2 AND field = $3 AND tenant_id = $4`,
    [JSON.stringify({ ...existingCfg, options: next }), refTableId, field, tenantId],
  );
  if (!opts.silent) {
    await appendAuditAs(
      userId,
      "Added field option",
      `${field} += "${label}"${color ? ` (${color})` : ""}`,
      { tenantId },
    );
  }
  return { options: next };
}

/** Set one enrichment field on a record record (only registered fields),
 *  cast to the field's declared type. */
export async function setFieldValue(
  refTableId: string,
  key: string,
  field: string,
  value: string | null,
  userId: string,
  tenantId: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return;
  const f = (await listFields(refTableId, tenantId)).find((x) => x.field === field);
  if (!f) return;
  if (f.type === "formula") return; // computed columns are read-only (no stored value)
  const col = qid(field);
  const keyc = qid(m.keyCol);
  const empty = value == null || value.trim() === "";
  // Snapshot the prior value so the record-history drawer can show a real
  // "before → after" diff. Only for user-facing edits — the bulk silent paths
  // don't surface in history and shouldn't pay for the extra read.
  const beforeText = opts.silent
    ? null
    : ((
        await pgGet<{ v: string | null }>(
          `SELECT ${col}::text AS v FROM ${cq(m.dimTable)} WHERE ${keyc} = $1`,
          [key],
        )
      )?.v ?? null);
  // Update the column and stamp record_version in one tx so the edit shows
  // up as an unpublished change (ADR-0002). The upsert also seeds a version row
  // for records created by bulk paths that never got one. RETURNING guards the
  // stamp: no refTable row updated → no stamp (don't touch retired/unknown keys).
  const applyUpdate = (val: unknown, cast = "") =>
    pgTx(async (tx) => {
      const updated = await tx.all<{ k: string }>(
        `UPDATE ${cq(m.dimTable)} SET ${col} = $1${cast} WHERE ${keyc} = $2 RETURNING ${keyc} AS k`,
        [val, key],
      );
      if (updated.length === 0) return false;
      await tx.run(
        `INSERT INTO "zugzug_app"."record_version" (reference_table_id, key, version, updated_at, updated_by, tenant_id)
         VALUES ($1, $2, 1, now(), $3, $4)
         ON CONFLICT (tenant_id, reference_table_id, key) DO UPDATE
            SET version    = "record_version".version + 1,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by`,
        [refTableId, key, userId, tenantId],
      );
      return true;
    });
  let changed: boolean;
  if (f.type === "number") {
    const n = empty ? null : Number(value);
    changed = await applyUpdate(Number.isFinite(n as number) ? n : null);
  } else if (f.type === "boolean") {
    const b = value === "true" ? true : value === "false" ? false : null;
    changed = await applyUpdate(b);
  } else if (f.type === "date") {
    const raw = empty ? null : value!.trim();
    // The driver parses the value before Postgres ever sees it, so unparseable
    // text ("hello", pasted from a spreadsheet) threw a RangeError → HTTP 500 →
    // a generic "Couldn't save". Refuse it as the validation error it is.
    if (raw !== null && Number.isNaN(new Date(raw).getTime())) {
      throw new AppError("VALIDATION_FAILED", `"${value}" isn't a date — use YYYY-MM-DD.`, 422);
    }
    changed = await applyUpdate(raw, "::date");
  } else if (f.type === "linked") {
    let fkValue: string | null = empty ? null : value!.trim();
    if (fkValue !== null && f.referencedRefTableId) {
      const tm = await refTableMeta(f.referencedRefTableId, tenantId);
      if (!tm) {
        // Target table is gone — storing the typed text would silently turn a
        // linked column into free text. Keep it empty instead.
        fkValue = null;
      } else {
        const exists = await pgGet(
          `SELECT 1 FROM ${cq(tm.dimTable)} WHERE ${qid(tm.keyCol)} = $1`,
          [fkValue],
        );
        if (!exists) {
          fkValue = null;
        } else if (f.referencedRefTableId === refTableId) {
          // Self-link = a parent pointer. Keep the data a valid tree: reject a
          // record parenting itself, or parenting a record it is already an
          // ancestor of (which would close a loop). Self-links were impossible
          // before this feature, so no pre-existing data can be cyclic and the
          // recursion always terminates.
          if (fkValue === key) {
            throw new AppError("HIERARCHY_CYCLE", "A record can't be its own parent.", 422);
          }
          const cyclic = await pgGet(
            `WITH RECURSIVE anc(p) AS (
               SELECT ${col} FROM ${cq(m.dimTable)} WHERE ${keyc} = $1
               UNION ALL
               SELECT d.${col} FROM ${cq(m.dimTable)} d JOIN anc ON d.${keyc} = anc.p
                WHERE anc.p IS NOT NULL
             )
             SELECT 1 FROM anc WHERE p = $2 LIMIT 1`,
            [fkValue, key],
          );
          if (cyclic) {
            throw new AppError("HIERARCHY_CYCLE", "Setting that parent would create a loop.", 422);
          }
        }
      }
    }
    changed = await applyUpdate(fkValue);
  } else {
    changed = await applyUpdate(empty ? null : value);
  }
  if (changed && !opts.silent) {
    await appendAuditAs(
      userId,
      "Edited record",
      `${key}.${field} → ${empty ? "(empty)" : `"${value}"`}`,
      {
        tableId: refTableId,
        rowKey: key,
        tenantId,
        metadata: {
          field,
          label: f.label,
          type: f.type,
          before: beforeText,
          after: empty ? null : value,
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// RefTable meta update
// ---------------------------------------------------------------------------

export interface UpdateRefTableMetaInput {
  orderingMode?: "derived" | "manual";
  description?: string | null;
  color?: string | null;
  ownerUserId?: string | null;
}

export async function updateRefTableMeta(
  refTableId: string,
  patch: UpdateRefTableMetaInput,
  userId: string,
  tenantId: string,
): Promise<{ id: string; orderingMode: string; description: string | null; color: string | null }> {
  const current = await pgGet<{
    dimTable: string;
    keyCol: string;
    keyKind: string;
    mapTable: string;
    orderingMode: string;
    description: string | null;
    color: string | null;
  }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol",
            COALESCE(key_kind, 'slug') AS "keyKind",
            map_table AS "mapTable",
            COALESCE(ordering_mode, 'derived') AS "orderingMode",
            description, color
     FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!current) throw new AppError("NOT_FOUND", `refTable ${refTableId} not found`, 404);

  if (patch.color !== undefined && patch.color !== null) {
    if (!(PALETTE_NAMES as readonly string[]).includes(patch.color)) {
      throw new AppError("VALIDATION_FAILED", `unknown color: ${patch.color}`, 422);
    }
  }
  if (
    patch.orderingMode !== undefined &&
    patch.orderingMode !== "derived" &&
    patch.orderingMode !== "manual"
  ) {
    throw new AppError("VALIDATION_FAILED", `unknown orderingMode: ${patch.orderingMode}`, 422);
  }
  if (patch.ownerUserId !== undefined && patch.ownerUserId !== null) {
    const member = await pgGet(
      `SELECT 1 FROM ${pg("tenant_member")} WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, patch.ownerUserId],
    );
    if (!member) {
      throw new AppError("VALIDATION_FAILED", "owner must be a workspace member", 422);
    }
  }

  const modeChanges =
    patch.orderingMode !== undefined && patch.orderingMode !== current.orderingMode;

  // Build SET clause for scalar fields only
  const sets: string[] = [];
  const vals: unknown[] = [refTableId, tenantId];
  if (patch.description !== undefined) {
    sets.push(`description = $${vals.length + 1}`);
    vals.push(patch.description?.trim() || null);
  }
  if (patch.color !== undefined) {
    sets.push(`color = $${vals.length + 1}`);
    vals.push(patch.color ?? null);
  }
  if (patch.ownerUserId !== undefined) {
    sets.push(`owner_user_id = $${vals.length + 1}`);
    vals.push(patch.ownerUserId ?? null);
  }
  if (modeChanges) {
    sets.push(`ordering_mode = $${vals.length + 1}`);
    vals.push(patch.orderingMode!);
  }
  if (sets.length > 0) {
    await pgRun(
      `UPDATE ${pg("reference_table")} SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2`,
      vals,
    );
  }

  if (modeChanges) {
    const DIMT = cq(current.dimTable);
    const k = qid(current.keyCol);
    const tiebreak = current.keyKind === "external_id" ? k : "d.label";

    if (patch.orderingMode === "manual") {
      // derived → manual: assign positions in current display order
      const rows = await pgAll<{ key: string }>(
        `SELECT d.${k} AS key FROM ${DIMT} d
         LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(current.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
         ORDER BY COALESCE(v.n, 0) DESC, ${tiebreak}`,
      );
      for (let i = 0; i < rows.length; i++) {
        await pgRun(`UPDATE ${DIMT} SET position = $1 WHERE ${k} = $2`, [
          (i + 1) * 1024,
          rows[i]!.key,
        ]);
      }
      await appendAuditAs(userId, "Switched ordering mode", `derived → manual`, {
        tableId: refTableId,
        tenantId,
        metadata: { from: "derived", to: "manual", backfilledRows: rows.length },
      });
    } else {
      // manual → derived: null all positions
      const result = await pgGet<{ n: number }>(
        `WITH upd AS (UPDATE ${DIMT} SET position = NULL RETURNING 1)
         SELECT count(*)::int AS n FROM upd`,
      ).catch(() => ({ n: 0 }));
      await appendAuditAs(userId, "Switched ordering mode", `manual → derived`, {
        tableId: refTableId,
        tenantId,
        metadata: { from: "manual", to: "derived", nulledRows: result?.n ?? 0 },
      });
    }
  }

  return {
    id: refTableId,
    orderingMode: modeChanges ? patch.orderingMode! : current.orderingMode,
    description:
      patch.description !== undefined ? patch.description?.trim() || null : current.description,
    color: patch.color !== undefined ? (patch.color ?? null) : current.color,
  };
}

// ---------------------------------------------------------------------------
// RefTable deletion
// ---------------------------------------------------------------------------

/** Permanently removes a table: metadata rows, the dim_/map_ Postgres tables,
 *  and the refTable row. Audit and outbound_event rows are kept — history
 *  outlives the table — and a final audit entry records the deletion. */
export async function deleteRefTable(
  id: string,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const refTable = await pgGet<{ id: string; label: string; dim_table: string; map_table: string }>(
    `SELECT id, label, dim_table, map_table FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if (!refTable) return false;
  // Use to_regclass to check table existence before counting — avoids
  // poisoning the transaction with a missing-table error (error code 42P01
  // inside a transaction leaves it in an aborted state for all later queries).
  const exists = await pgGet<{ r: string | null }>(`SELECT to_regclass($1) AS r`, [
    refTable.dim_table,
  ]);
  const count = exists?.r
    ? await pgGet<{ n: number }>(`SELECT count(*)::int AS n FROM ${cq(refTable.dim_table)}`)
    : { n: 0 };
  // Linked columns on OTHER tables point here. Left behind they resolve to no
  // target, so setFieldValue stops validating them and they degrade into free
  // text — drop them with their lookup columns instead.
  const dependents = await pgAll<{ reference_table_id: string; field: string }>(
    `SELECT reference_table_id, field FROM ${pg("reference_table_field")}
      WHERE type = 'linked' AND tenant_id = $2 AND reference_table_id <> $1
        AND field_config::jsonb ->> 'targetRefTableId' = $1`,
    [id, tenantId],
  );
  for (const d of dependents) {
    await deleteColumn(d.reference_table_id, d.field, userId, tenantId);
  }
  const tenantSweeps = [
    "reference_table_source",
    "reference_table_field",
    "draft",
    "source_stat",
    "ai_hint_cache",
    "record_version",
    // Publish history — a recreated table with the same name must start at
    // version 0, not inherit the deleted table's versions and snapshots.
    "reference_table_version",
    "outbound_event",
  ];
  for (const t of tenantSweeps) {
    await pgRun(`DELETE FROM ${pg(t)} WHERE reference_table_id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
  }
  // user_grid_layout has no tenant_id column — scope to the calling tenant's members
  await pgRun(
    `DELETE FROM ${pg("user_grid_layout")} WHERE reference_table_id = $1
       AND user_id IN (SELECT user_id FROM ${pg("tenant_member")} WHERE tenant_id = $2)`,
    [id, tenantId],
  );
  await pgRun(`DROP TABLE IF EXISTS ${cq(refTable.dim_table)}`);
  await pgRun(`DROP TABLE IF EXISTS ${cq(refTable.map_table)}`);
  await pgRun(`DELETE FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`, [
    id,
    tenantId,
  ]);
  const dimTableShort = refTable.dim_table.includes(".")
    ? refTable.dim_table.split(".").pop()!
    : refTable.dim_table;
  const mapTableShort = refTable.map_table.includes(".")
    ? refTable.map_table.split(".").pop()!
    : refTable.map_table;
  await appendAuditAs(
    userId,
    "Deleted table",
    `${refTable.label} — ${count?.n ?? 0} records; dropped ${dimTableShort} + ${mapTableShort}`,
    { tableId: id, tenantId },
  );
  return true;
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

export async function rebalanceRefTablePositions(
  refTableId: string,
  m: { dimTable: string; keyCol: string },
  userId: string,
  tenantId: string,
  trigger: "manual" | "collision" | "threshold",
): Promise<number> {
  const DIMT = cq(m.dimTable);
  const KC = qid(m.keyCol);
  const rows = await pgAll<{ key: string }>(
    `SELECT ${KC} AS key FROM ${DIMT} WHERE position IS NOT NULL ORDER BY position ASC`,
  );
  for (let i = 0; i < rows.length; i++) {
    await pgRun(`UPDATE ${DIMT} SET position = $1 WHERE ${KC} = $2`, [
      (i + 1) * 1024,
      rows[i]!.key,
    ]);
  }
  if (trigger !== "collision") {
    await appendAuditAs(userId, "Rebalanced positions", `${rows.length} rows`, {
      tableId: refTableId,
      tenantId,
      metadata: { rebalancedRows: rows.length, trigger },
    });
  }
  return rows.length;
}

export async function addRecordOneAt(
  refTableId: string,
  label: string,
  key: string | undefined,
  insertAt: { anchor: string; direction: "above" | "below" },
  userId: string,
  tenantId: string,
): Promise<void> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return;
  if (m.orderingMode !== "manual") {
    return addRecordOne(refTableId, label, key, userId, tenantId);
  }
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  const DIMT = cq(m.dimTable);
  const KC = qid(m.keyCol);

  const anchor = await pgGet<{ position: string | null }>(
    `SELECT position FROM ${DIMT} WHERE ${KC} = $1`,
    [insertAt.anchor],
  );
  if (!anchor) throw new AppError("NOT_FOUND", `anchor ${insertAt.anchor} not found`, 404);

  const anchorPos = anchor.position == null ? null : BigInt(anchor.position);

  let neighbourPos: bigint | null = null;
  if (anchorPos !== null) {
    if (insertAt.direction === "above") {
      const prev = await pgGet<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position < $1
         ORDER BY position DESC LIMIT 1`,
        [String(anchorPos)],
      );
      neighbourPos = prev?.position == null ? null : BigInt(prev.position);
    } else {
      const next = await pgGet<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position > $1
         ORDER BY position ASC LIMIT 1`,
        [String(anchorPos)],
      );
      neighbourPos = next?.position == null ? null : BigInt(next.position);
    }
  }

  const pAbove = insertAt.direction === "above" ? neighbourPos : anchorPos;
  const pBelow = insertAt.direction === "above" ? anchorPos : neighbourPos;
  let newPos = computeInsertPosition(pAbove, pBelow);

  if (newPos === null) {
    await rebalanceRefTablePositions(refTableId, m, userId, tenantId, "collision");
    const refreshed = await pgGet<{ position: string | null }>(
      `SELECT position FROM ${DIMT} WHERE ${KC} = $1`,
      [insertAt.anchor],
    );
    if (!refreshed?.position)
      throw new AppError("NOT_FOUND", `anchor ${insertAt.anchor} not found after rebalance`, 404);
    const ap2 = BigInt(refreshed.position);
    if (insertAt.direction === "above") {
      const prev2 = await pgGet<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position < $1 ORDER BY position DESC LIMIT 1`,
        [String(ap2)],
      );
      newPos =
        computeInsertPosition(prev2?.position == null ? null : BigInt(prev2.position), ap2) ??
        ap2 - 512n;
    } else {
      const next2 = await pgGet<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE position IS NOT NULL AND position > $1 ORDER BY position ASC LIMIT 1`,
        [String(ap2)],
      );
      newPos =
        computeInsertPosition(ap2, next2?.position == null ? null : BigInt(next2.position)) ??
        ap2 + 512n;
    }
  }

  await pgTx(async (tx) => {
    const inserted = await tx.get<{ k: string }>(
      `INSERT INTO ${DIMT} (${KC}, label, position) VALUES ($1, $2, $3)
       ON CONFLICT (${KC}) DO NOTHING
       RETURNING ${KC} AS k`,
      [k, label, String(newPos!)],
    );
    if (!inserted) throw new AppError("ALREADY_EXISTS", duplicateKeyMessage(k), 409);
    await seedVersionRow(tx, refTableId, k, userId, tenantId);
  });

  await appendAuditAs(userId, "Inserted record at position", `${label} (${k})`, {
    tableId: refTableId,
    rowKey: k,
    tenantId,
    metadata: { key: k, anchor: insertAt.anchor, direction: insertAt.direction },
  });
}

/** Move a record row to a new position in manual-ordering mode.
 *  before / after are the keys of the immediate neighbours in the desired
 *  final order (null = move to top/bottom). */
export async function reorderRecordRow(
  refTableId: string,
  rowKey: string,
  before: string | null | undefined,
  after: string | null | undefined,
  userId: string,
  tenantId: string,
): Promise<{ position: string }> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) throw new AppError("NOT_FOUND", `refTable ${refTableId} not found`, 404);
  if (m.orderingMode !== "manual") {
    throw new AppError("CONFLICT", "refTable is not in manual ordering mode", 409);
  }
  const DIMT = cq(m.dimTable);
  const KC = qid(m.keyCol);

  return await pgTx(async (tx) => {
    // Verify target exists
    const target = await tx.get<{ position: string | null }>(
      `SELECT position FROM ${DIMT} WHERE ${KC} = $1 FOR UPDATE`,
      [rowKey],
    );
    if (!target) throw new AppError("NOT_FOUND", `row ${rowKey} not found`, 404);

    // Resolve anchor positions
    let pBefore: bigint | null = null;
    let pAfter: bigint | null = null;

    if (before != null) {
      const br = await tx.get<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE ${KC} = $1 FOR UPDATE`,
        [before],
      );
      if (!br) throw new AppError("NOT_FOUND", `before anchor ${before} not found`, 404);
      pBefore = br.position == null ? null : BigInt(br.position);
    } else if (before === null) {
      // Move to top: position goes before the current minimum
      const minRow = await tx.get<{ p: string | null }>(
        `SELECT MIN(position)::text AS p FROM ${DIMT} WHERE position IS NOT NULL AND ${KC} != $1`,
        [rowKey],
      );
      pBefore = null;
      pAfter = minRow?.p == null ? null : BigInt(minRow.p);
    }

    if (after != null) {
      const ar = await tx.get<{ position: string | null }>(
        `SELECT position FROM ${DIMT} WHERE ${KC} = $1 FOR UPDATE`,
        [after],
      );
      if (!ar) throw new AppError("NOT_FOUND", `after anchor ${after} not found`, 404);
      pAfter = ar.position == null ? null : BigInt(ar.position);
    } else if (after === null && before !== null) {
      // Move to bottom: position goes after the current maximum
      const maxRow = await tx.get<{ p: string | null }>(
        `SELECT MAX(position)::text AS p FROM ${DIMT} WHERE position IS NOT NULL AND ${KC} != $1`,
        [rowKey],
      );
      pBefore = maxRow?.p == null ? null : BigInt(maxRow.p);
      pAfter = null;
    }

    // Verify anchors are still consecutive (detect stale drag)
    if (pBefore !== null && pAfter !== null) {
      const between = await tx.get<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${DIMT}
         WHERE position IS NOT NULL AND position > $1 AND position < $2 AND ${KC} != $3`,
        [String(pBefore), String(pAfter), rowKey],
      );
      if ((between?.n ?? 0) > 0) {
        throw new AppError("CONFLICT", "anchors are no longer consecutive", 409);
      }
    }

    // Idempotent check — already in the right slot
    const tPos = target.position == null ? null : BigInt(target.position);
    if (tPos !== null && pBefore !== null && pAfter !== null && tPos > pBefore && tPos < pAfter) {
      return { position: String(tPos) };
    }

    const newPos = computeInsertPosition(pBefore, pAfter);
    if (newPos === null) {
      throw new AppError("CONFLICT", "positions too tight, rebalance needed", 409);
    }

    await tx.run(`UPDATE ${DIMT} SET position = $1 WHERE ${KC} = $2`, [String(newPos), rowKey]);
    // position is a published column, so a move is an unpublished change like
    // any cell edit — without the stamp, publish never sees the new order.
    await touchVersionRow(tx, refTableId, rowKey, userId, tenantId);

    await appendAuditAs(userId, "Reordered record", rowKey, {
      tableId: refTableId,
      rowKey,
      tenantId,
      metadata: { key: rowKey, before: before ?? null, after: after ?? null },
    });

    return { position: String(newPos) };
  });
}

/** The raw variants that resolve to a record key — the lineage "receipt". */
export async function listVariants(
  refTableId: string,
  key: string,
  tenantId: string,
): Promise<string[]> {
  const m = await refTableMeta(refTableId, tenantId);
  if (!m) return [];
  const rows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1 ORDER BY raw LIMIT 300`,
    [key],
  );
  return rows.map((r) => r.raw);
}
