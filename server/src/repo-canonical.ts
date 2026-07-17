/* repo-canonical.ts — dimension registry + canonical CRUD + field/column management.
 *
 * All data lives in Postgres (dim_/map_ tables in the canonical schema +
 * the app-state dimension/dimension_field tables). Warehouse (DuckDB) is
 * touched only in getDimension (to resolve live names for external_id dims). */

import { getAdapter } from "./warehouse/registry.ts";
import {
  type DimensionMeta,
  type MappingDimension,
  type CanonicalValue,
  type FieldDef,
  type OptionDef,
  type PaletteName,
  type NumberFormat,
  PALETTE_NAMES,
  refForRegisteredTable,
  slug,
  qid,
  cq,
  dimMeta,
  type DimMeta,
  parseFieldConfig,
  pgAll,
  pgGet,
  pgRun,
  pgTx,
  env,
  pg,
} from "./repo-shared.ts";
import { getDimScanScalars, type DimScanScalars } from "./repo-dim-scan.ts";
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
 *  Returns 1024n when the dim has no positioned rows yet.
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
 *  deriveCanonical) and need to land a row in dimension_source. Throws if
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

/** Remove a single wired source column from a dimension. Idempotent — deleting
 *  a nonexistent wiring is a no-op. */
export async function removeSource(
  dimId: string,
  source: QualifiedSource,
  tenantId: string,
): Promise<void> {
  await pgRun(
    `DELETE FROM ${pg("dimension_source")}
      WHERE tenant_id = $1 AND dim_id = $2 AND database_id = $3
        AND schema_name = $4 AND table_name = $5 AND column_name = $6`,
    [tenantId, dimId, source.databaseId, source.schemaName, source.tableName, source.columnName],
  );
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

/** Inside an existing pgTx, attempt to bump the version row for (dim_id, key).
 *  On success: returns the new version.
 *  On expected-version mismatch: throws AppError CONFLICT with details.current. */
async function bumpVersionOrThrow(
  tx: TxLike,
  dimId: string,
  key: string,
  expectedVersion: number,
  userId: string,
  tenantId: string,
  meta: DimMeta,
): Promise<number> {
  const rows = await tx.all<{ version: number }>(
    `UPDATE "zugzug_app"."canonical_version"
        SET version = version + 1, updated_at = now(), updated_by = $1
      WHERE dim_id = $2 AND key = $3 AND version = $4 AND tenant_id = $5
        AND retired_at IS NULL
    RETURNING version`,
    [userId, dimId, key, expectedVersion, tenantId],
  );
  if (rows.length === 1) return rows[0]!.version;

  const cur = await tx.get<CurrentVersionRow>(
    `SELECT cv.version, cv.updated_at, cv.updated_by,
            u.name, u.initials
       FROM "zugzug_app"."canonical_version" cv
       LEFT JOIN "zugzug_app"."users" u ON u.id = cv.updated_by
      WHERE cv.dim_id = $1 AND cv.key = $2 AND cv.tenant_id = $3
        AND cv.retired_at IS NULL`,
    [dimId, key, tenantId],
  );
  if (!cur) {
    // No version row exists. Rows created by the bulk derive/seed paths
    // (deriveCanonical, addCanonical) never got one, so the read path reports
    // them as version 1. If the canonical row actually exists and the client is
    // at that implied v1, lazily seed the version row and bump it (to 2) rather
    // than 404. This backfills legacy rows on their first edit. Any other
    // expectedVersion for a row with no version row is a genuine mismatch.
    const exists = await tx.get<{ one: number }>(
      `SELECT 1 AS one FROM ${cq(meta.dimTable)} WHERE ${qid(meta.keyCol)} = $1`,
      [key],
    );
    if (exists && expectedVersion === 1) {
      const seeded = await tx.all<{ version: number }>(
        `INSERT INTO "zugzug_app"."canonical_version"
              (dim_id, key, version, updated_at, updated_by, tenant_id)
         VALUES ($1, $2, 2, now(), $3, $4)
         ON CONFLICT (tenant_id, dim_id, key) DO UPDATE
            SET version      = "canonical_version".version + 1,
                updated_at   = now(),
                updated_by   = EXCLUDED.updated_by,
                retired_at   = NULL,
                retired_into = NULL
         RETURNING version`,
        [dimId, key, userId, tenantId],
      );
      if (seeded.length === 1) return seeded[0]!.version;
    }
    throw new AppError("NOT_FOUND", `canonical ${dimId}/${key} not found`, 404);
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

/** New canonical → version row at version=1 owned by userId. Use inside an existing tx. */
async function seedVersionRow(
  tx: TxLike,
  dimId: string,
  key: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  await tx.run(
    `INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by, tenant_id)
     VALUES ($1, $2, 1, now(), $3, $4)
     ON CONFLICT (tenant_id, dim_id, key) DO UPDATE
        SET retired_at  = NULL,
            retired_into = NULL,
            version     = "canonical_version".version + 1,
            updated_at  = now(),
            updated_by  = EXCLUDED.updated_by`,
    [dimId, key, userId, tenantId],
  );
}

/** Soft-retire the version row: set retired_at, leave retired_into NULL (no merge target). */
async function softRetireVersionRow(
  tx: TxLike,
  dimId: string,
  key: string,
  tenantId: string,
): Promise<void> {
  await tx.run(
    `UPDATE "zugzug_app"."canonical_version"
        SET retired_at = now(), retired_into = NULL
      WHERE dim_id = $1 AND key = $2 AND tenant_id = $3`,
    [dimId, key, tenantId],
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

/* ---- dimension registry (Postgres) + canonical tables ---- */
export async function listDimensions(tenantId: string): Promise<DimensionMeta[]> {
  const metas = await pgAll<Omit<DimensionMeta, "rows">>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} WHERE tenant_id = $1 ORDER BY label`,
    [tenantId],
  );
  const counts = await Promise.all(
    metas.map((m) =>
      pgGet<{ n: number }>(`SELECT count(*)::int AS n FROM ${cq(m.mapTable)}`).catch(() => null),
    ),
  );

  return metas.map((m, i) => ({ ...m, rows: Number(counts[i]?.n ?? 0) }));
}

/** Lightweight dimension lookup — id + display label only, scoped to tenant.
 *  Used where the full canonical materialization in `getDimension` is overkill
 *  (e.g. the AI suggestion workflow that just needs the dimension name). */
export async function getDimensionBasic(
  id: string,
  tenantId: string,
): Promise<{ id: string; label: string } | null> {
  const row = await pgGet<{ id: string; label: string }>(
    `SELECT id, label FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [id, tenantId],
  );
  return row ?? null;
}

/** Sample of existing canonical labels for a dimension, scoped to tenant.
 *  Reads the dynamic `dim_*` table whose name lives in the dimension registry. */
export async function getCanonicalValues(
  dimId: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 1000));
  const meta = await pgGet<{ dimTable: string }>(
    `SELECT dim_table AS "dimTable" FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) return [];
  const rows = await pgAll<{ label: string }>(
    `SELECT DISTINCT label FROM ${cq(meta.dimTable)}
     WHERE label IS NOT NULL ORDER BY label ASC LIMIT ${limit}`,
  ).catch(() => [] as { label: string }[]);
  return rows.map((r) => r.label);
}

export async function getDimension(
  id: string,
  tenantId: string,
  opts?: { scalars?: DimScanScalars[] },
): Promise<MappingDimension | null> {
  const meta = await pgGet<
    Omit<DimensionMeta, "rows"> & {
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
    `SELECT dim.id, dim.label AS dimension, dim.dim_table AS "dimTable", dim.map_table AS "mapTable",
            dim.key_col AS "keyCol", COALESCE(dim.key_kind, 'slug') AS "keyKind",
            dim.name_table AS "nameTable", dim.name_id_col AS "nameIdCol", dim.name_col AS "nameCol",
            dim.description, dim.color, dim.owner_user_id AS "ownerUserId", u.name AS "ownerName",
            COALESCE(dim.ordering_mode, 'derived') AS "orderingMode"
     FROM ${pg("dimension")} dim
     LEFT JOIN ${pg("users")} u ON u.id = dim.owner_user_id
     WHERE dim.id = $1 AND dim.tenant_id = $2`,
    [id, tenantId],
  );
  if (!meta) return null;

  const k = qid(meta.keyCol);
  const fields = await listFields(id, tenantId);
  const scalarFields = fields.filter((f) => f.type !== "linked");
  const linkedFields = fields.filter((f) => f.type === "linked");

  // Pre-fetch target dim metadata for each linked field (needed for JOIN)
  const linkedMetas = new Map<string, { keyCol: string; dimTable: string }>();
  for (const lf of linkedFields) {
    if (lf.referencedDimId) {
      const tm = await dimMeta(lf.referencedDimId, tenantId);
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

  // Fetch canonical rows from Postgres
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

  // For external_id dims with warehouse attached: resolve names from MotherDuck
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
    `SELECT key, version FROM ${pg("canonical_version")} WHERE dim_id = $1 AND tenant_id = $2 AND retired_at IS NULL`,
    [id, tenantId],
  );
  const versions = new Map(versionRows.map((r) => [r.key, Number(r.version)]));

  const canonical = canonRows.map((r) => ({
    key: String(r.key),
    label: r.label == null ? String(r.key) : String(r.label),
    version: versions.get(String(r.key)) ?? 1,
    unresolved: !!r.unresolved,
    variants: Number(r.variants),
    position: r.position == null ? null : String(r.position as string | bigint),
    fields: Object.fromEntries(
      allFieldKeys.map((fk) => [fk, r[fk] == null ? null : String(r[fk])]),
    ),
  }));

  const rowsRow = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(meta.mapTable)}`,
  ).catch(() => null);
  const scalars = opts?.scalars ?? (await getDimScanScalars(tenantId));
  const my = scalars.find((s) => s.dimId === id);
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
    canonical,
    counts,
    fields,
  };
}

/** Create a dimension: register it + provision dim_/map_ (Postgres). Idempotent
 *  on the id. For key_kind 'external_id' the dim_ label is nullable (names are
 *  resolved live from the warehouse, not stored). Source bindings are added
 *  separately via addSource() / dimension_source inserts. */
export async function addDimension(
  name: string,
  sources: QualifiedSource[] = [],
  opts: { keyKind?: "slug" | "external_id"; silent?: boolean } = {},
  userId: string,
  tenantId: string,
): Promise<string> {
  const id = slug(name);
  if (!id) return id;
  const keyKind = opts.keyKind === "external_id" ? "external_id" : "slug";
  const dimTable = `${env.canonicalSchema}.dim_${id}`;
  const mapTable = `${env.canonicalSchema}.map_${id}`;
  const keyCol = `${id}_code`;
  // Dim ids are globally unique (see 0011_mt_data_foundation.sql "DECISION
  // (dimension identity)"); a same-named dim in two tenants would collide here.
  // Existence check stays unscoped so we don't double-create the dim_/map_
  // tables, but the INSERT below carries tenant_id so the dimension row is
  // owned by the calling tenant.
  const TENANT_ID_RE = /^[a-z][a-z0-9_]{0,20}$/;
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`addDimension: invalid tenant_id ${tenantId}`);
  }
  const tenantLit = `'${tenantId}'`;
  const existing = await pgGet(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
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
      `INSERT INTO ${pg("dimension")} (id, label, dim_table, map_table, key_col, key_kind, created_at, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, $7)`,
      [id, name.trim(), dimTable, mapTable, keyCol, keyKind, tenantId],
    );
    if (!opts.silent) {
      await appendAuditAs(
        userId,
        "Created dimension",
        `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`,
        { tenantId },
      );
    }
  }
  for (const s of sources) {
    await pgRun(
      `INSERT INTO ${pg("dimension_source")} (dim_id, tenant_id, database_id, schema_name, table_name, column_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, dim_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
      [id, tenantId, s.databaseId, s.schemaName, s.tableName, s.columnName],
    );
  }
  return id;
}

/** Seed canonical values into a dimension's dim_ table (idempotent). */
export async function addCanonical(
  dimId: string,
  values: CanonicalValue[],
  tenantId: string,
): Promise<void> {
  const meta = await dimMeta(dimId, tenantId);
  if (!meta) return;
  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (dim ids are globally unique → effectively
  // per-tenant via the dimension registry's WHERE tenant_id = $N gate above).
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

/** Add one canonical record (key derived from the label if not given). */
export async function addCanonicalOne(
  dimId: string,
  label: string,
  key: string | undefined,
  userId: string,
  tenantId: string,
): Promise<void> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) return;
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (dim ids are globally unique → effectively
  // per-tenant via the dimension registry's WHERE tenant_id = $N gate above).
  await pgTx(async (tx) => {
    if (m.orderingMode === "manual") {
      const pos = await nextPosition(tx, m.dimTable);
      await tx.run(
        `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label, position) VALUES ($1, $2, $3)
         ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
        [k, label, String(pos)],
      );
    } else {
      await tx.run(
        `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
         ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
        [k, label],
      );
    }
    await seedVersionRow(tx, dimId, k, userId, tenantId);
  });
  await appendAuditAs(userId, "Added canonical", `${label} (${k})`, {
    tableId: dimId,
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
export async function importCanonical(
  dimId: string,
  rows: ImportRow[],
  userId: string,
  tenantId: string,
): Promise<{ created: number; updated: number; skipped: number }> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) throw new AppError("NOT_FOUND", `dimension ${dimId} not found`, 404);
  const defs = await listFields(dimId, tenantId);
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
            await seedVersionRow(tx, dimId, key, userId, tenantId);
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
      for (const [f, v] of entries) await setFieldValue(dimId, key, f, v, tenantId);
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
        for (const [f, v] of fieldEntries) await setFieldValue(dimId, key, f, v, tenantId);
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
          await seedVersionRow(tx, dimId, key, userId, tenantId);
        });
        for (const [f, v] of fieldEntries) await setFieldValue(dimId, key, f, v, tenantId);
        existing.add(key);
        created++;
      }
    }
  }
  await appendAuditAs(
    userId,
    "Imported CSV",
    `${created} created · ${updated} updated · ${skipped} skipped`,
    { tableId: dimId, tenantId },
  );
  return { created, updated, skipped };
}

/** Rename a canonical's display label (the key is stable). */
export async function renameCanonical(
  dimId: string,
  key: string,
  label: string,
  userId: string,
  expectedVersion: number,
  tenantId: string,
): Promise<{ version: number }> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) throw new AppError("NOT_FOUND", `dimension ${dimId} not found`, 404);

  // Fetch old label before overwriting — needed for ai_hint_cache sync below.
  // PR2b Task 8 adds tenant_id to dim_*/map_*. Until then, the dynamic SQL
  // stays per-tenant-implicit (dim ids are globally unique → effectively
  // per-tenant via the dimension registry's WHERE tenant_id = $N gate above).
  const oldRow = await pgGet<{ label: string }>(
    `SELECT label FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  ).catch(() => null);

  const newVersion = await pgTx(async (tx) => {
    const v = await bumpVersionOrThrow(tx, dimId, key, expectedVersion, userId, tenantId, m);
    await tx.run(`UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`, [
      label,
      key,
    ]);
    return v;
  });

  await appendAuditAs(userId, "Renamed canonical", `${key} → "${label}"`, {
    tableId: dimId,
    rowKey: key,
    tenantId,
  });

  // Keep ai_hint_cache consistent: update any hint that was pointing at the old label.
  if (oldRow?.label) {
    await pgRun(
      `UPDATE ${pg("ai_hint_cache")} SET suggestion = $1
       WHERE dim_id = $2 AND suggestion = $3 AND tenant_id = $4`,
      [label, dimId, oldRow.label, tenantId],
    ).catch(() => {
      /* table may not exist in older deploys */
    });
  }

  return { version: newVersion };
}

/** Merge loser canonicals into a survivor: re-point every crosswalk row, drop the
 *  losers' golden records, audit. The core MDM consolidation step. */
export async function mergeCanonical(
  dimId: string,
  survivor: string,
  losers: string[],
  userId: string,
  expectedVersions: Record<string, number>,
  tenantId: string,
): Promise<number> {
  const m = await dimMeta(dimId, tenantId);
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
       UPDATE "zugzug_app"."canonical_version" cv
          SET version = cv.version + 1, updated_at = now(), updated_by = $1
         FROM expected e
        WHERE cv.dim_id = '${dimId.replace(/'/g, "''")}'
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
           FROM "zugzug_app"."canonical_version" cv
           LEFT JOIN "zugzug_app"."users" u ON u.id = cv.updated_by
          WHERE cv.dim_id = $1 AND cv.key = $2 AND cv.tenant_id = $3
            AND cv.retired_at IS NULL`,
        [dimId, missed[0]!, tenantId],
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
      `UPDATE "zugzug_app"."canonical_version"
          SET retired_at = now(), retired_into = $4
        WHERE dim_id = $1 AND key = ANY($2::text[]) AND tenant_id = $3`,
      [dimId, real, tenantId, survivor],
    );
  });

  await appendAuditAs(userId, "Merged canonical", `${real.join(", ")} → ${survivor}`, {
    tableId: dimId,
    rowKey: survivor,
    tenantId,
  });
  return real.length;
}

/** Retire a canonical — governed: refused while raw variants still map to it. */
export async function retireCanonical(
  dimId: string,
  key: string,
  userId: string,
  expectedVersion: number,
  tenantId: string,
): Promise<{ ok: boolean; variants: number }> {
  const m = await dimMeta(dimId, tenantId);
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

    await bumpVersionOrThrow(tx, dimId, key, expectedVersion, userId, tenantId, m);

    // Read the label BEFORE the DELETE so the outbound event carries the
    // human-facing name as it existed at the time of retirement. Each dim
    // has its own dim_<slug> table so (key) is the natural identifier here.
    const labelRow = await tx.get<{ label: string }>(
      `SELECT label FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`,
      [key],
    );

    await tx.run(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
    await softRetireVersionRow(tx, dimId, key, tenantId);

    // Atomic outbound event — fails the tx if the INSERT does (design §3.1).
    const firedAt = new Date();
    await dispatchOutbound(tx, {
      tenantId,
      type: "record.deleted",
      dimId,
      occurredAt: firedAt,
      payload: {
        dim_slug: dimId,
        key,
        label: labelRow?.label ?? key,
        deleted_by: { id: userId },
      },
      // Includes timestamp so concurrent retire calls of the same key (e.g.
      // re-add then re-retire) produce distinct idem keys.
      idemKey: `record.deleted:${dimId}:${key}:${firedAt.getTime()}`,
    });

    return { ok: true, variants: 0 };
  });

  if (result.ok) {
    await appendAuditAs(userId, "Retired canonical", key, {
      tableId: dimId,
      rowKey: key,
      tenantId,
    });
  }
  return result;
}

/* ---- enrichment fields (attribute columns on dim_) ---- */
export async function listFields(dimId: string, tenantId: string): Promise<FieldDef[]> {
  const rows = await pgAll<{
    field: string;
    label: string;
    type: string;
    field_config: string | null;
    description: string | null;
  }>(
    `SELECT field, label, type, field_config, description FROM ${pg("dimension_field")} WHERE dim_id = $1 AND tenant_id = $2 ORDER BY created_at`,
    [dimId, tenantId],
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
  dimId: string,
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
      `UPDATE ${pg("dimension_field")} SET description = $1 WHERE dim_id = $2 AND field = $3 AND tenant_id = $4`,
      [desc, dimId, field, tenantId],
    );
    await appendAuditAs(userId, "Updated field description", field, { tenantId });
  }

  if (updates.fieldConfig !== undefined) {
    // Read the existing field_config, parse it, shallow-merge with the incoming
    // JSON, then write back — so PATCHes with one key (e.g. rules) don't wipe
    // the rest of the column's config (options, numberFormat, ratingMax, …).
    const existing = await pgGet<{ field_config: string | null; type: string }>(
      `SELECT field_config, type FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2 AND tenant_id = $3`,
      [dimId, field, tenantId],
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

    if ("targetDimId" in incomingParsed) {
      const incomingTarget = String(incomingParsed.targetDimId ?? "");
      const currentTarget =
        typeof currentCfg.targetDimId === "string" ? currentCfg.targetDimId : "";
      if (currentTarget !== "" && incomingTarget !== "" && incomingTarget !== currentTarget) {
        throw new Error("targetDimId is immutable after creation; delete and recreate the field");
      }
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
      const targetDimId =
        (typeof currentCfg.targetDimId === "string" ? currentCfg.targetDimId : "") ||
        (typeof incomingParsed.targetDimId === "string" ? incomingParsed.targetDimId : "");
      if (targetDimId === "") {
        throw new Error("displayFields update requires a target dimension");
      }
      const targetFields = await pgAll<{ field: string }>(
        `SELECT field FROM ${pg("dimension_field")} WHERE dim_id = $1 AND tenant_id = $2`,
        [targetDimId, tenantId],
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
        throw new Error(`displayFields entry not found on target dimension: ${entry}`);
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
      `UPDATE ${pg("dimension_field")} SET field_config = $1 WHERE dim_id = $2 AND field = $3 AND tenant_id = $4`,
      [mergedConfig, dimId, field, tenantId],
    );
    if (incomingCfg !== null && "rules" in incomingCfg) {
      await appendAuditAs(userId, "Updated field rules", field, { tenantId });
    }
    if (beforeDisplayFields !== null && afterDisplayFields !== null) {
      await appendAuditAs(userId, "field.displayFields.update", field, {
        tableId: dimId,
        tenantId,
        metadata: { before: beforeDisplayFields, after: afterDisplayFields },
      });
    }
  }
}

/** Add an attribute column to a dimension's dim_ table (ALTER TABLE). type ∈
 *  text | number | boolean | date | select | url | email | rating.
 *  Select columns store an ordered option list in `dimension_field.field_config` (JSON);
 *  the dim_ column is VARCHAR (the value IS the option label).
 *  Rating columns store { ratingMax } in field_config. */
export async function addField(
  dimId: string,
  label: string,
  type: string = "text",
  options: OptionDef[] | undefined,
  opts: {
    silent?: boolean;
    numberFormat?: NumberFormat;
    ratingMax?: number;
    referencedDimId?: string;
    displayFields?: string[];
  } = {},
  userId: string,
  tenantId: string,
): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId, tenantId);
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
  ]);
  const t = KNOWN.has(type) ? type : "text";

  if (t === "linked") {
    if (!opts.referencedDimId) return null;
    if (opts.referencedDimId === dimId) return null;
    const targetMeta = await dimMeta(opts.referencedDimId, tenantId);
    if (!targetMeta) return null;
    const targetFieldNames = new Set(
      (await listFields(opts.referencedDimId, tenantId)).map((f) => f.field),
    );
    const dfs = opts.displayFields ?? ["label"];
    // "label" is always present on every dim_* table; validate any others
    if (!dfs.every((df) => df === "label" || targetFieldNames.has(df))) return null;
  }

  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null;
  const sqlType = SQL_TYPE[t] ?? "VARCHAR";
  await pgRun(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
  const optsJson =
    t === "select"
      ? JSON.stringify({ options: options ?? [] })
      : t === "number" && opts.numberFormat != null
        ? JSON.stringify({ numberFormat: opts.numberFormat })
        : t === "rating"
          ? JSON.stringify({ ratingMax: opts.ratingMax ?? 5 })
          : t === "linked"
            ? JSON.stringify({
                targetDimId: opts.referencedDimId,
                displayFields: opts.displayFields ?? ["label"],
              })
            : null;
  await pgRun(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, field_config, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, current_timestamp, $6) ON CONFLICT (tenant_id, dim_id, field) DO NOTHING`,
    [dimId, field, label.trim(), t, optsJson, tenantId],
  );
  if (!opts.silent) {
    await appendAuditAs(userId, "Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`, {
      tenantId,
    });
  }
  return { field };
}

/** Rename a column's display label. The `field` (stable id / DB column name)
 *  stays put; only `label` changes. */
export async function renameColumn(
  dimId: string,
  field: string,
  newLabel: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  await pgRun(
    `UPDATE ${pg("dimension_field")} SET label = $1 WHERE dim_id = $2 AND field = $3 AND tenant_id = $4`,
    [label, dimId, field, tenantId],
  );
  await appendAuditAs(userId, "Renamed column", `${field} → "${label}"`, { tenantId });
}

/** Change a column's type. Validates that every existing cell value parses to
 *  the new type; returns { ok: false, invalidCount } when N cells would
 *  silently null. Caller decides whether to retry with coerceInvalidToNull. */
export async function changeColumnType(
  dimId: string,
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
  const m = await dimMeta(dimId, tenantId);
  if (!m) return { ok: false };
  const f = (await listFields(dimId, tenantId)).find((x) => x.field === field);
  if (!f) return { ok: false };
  if (f.type === "linked" || opts.newType === "linked") return { ok: false };
  const col = qid(field);
  const keyc = qid(m.keyCol);
  const { newType, coerceInvalidToNull, userId } = opts;

  // VARCHAR relabels — only safe when current SQL type is already VARCHAR
  if (
    (newType === "url" || newType === "email") &&
    (f.type === "text" || f.type === "select" || f.type === "url" || f.type === "email")
  ) {
    await pgTx(async ({ run }) => {
      await run(
        `UPDATE ${pg("dimension_field")} SET type = $1, field_config = null WHERE dim_id = $2 AND field = $3 AND tenant_id = $4`,
        [newType, dimId, field, tenantId],
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
      `UPDATE ${pg("dimension_field")} SET type = $1, field_config = $2 WHERE dim_id = $3 AND field = $4 AND tenant_id = $5`,
      [
        newType,
        newType === "select"
          ? JSON.stringify(finalOptions ?? [])
          : newType === "number" && opts.numberFormat != null
            ? JSON.stringify({ numberFormat: opts.numberFormat })
            : newType === "rating"
              ? JSON.stringify({ ratingMax: opts.ratingMax ?? 5 })
              : null,
        dimId,
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

/** Drop a column from the dim_ table AND its row in dimension_field, plus null
 *  the field on every row of the dim. Transactional — all-or-nothing. */
export async function deleteColumn(
  dimId: string,
  field: string,
  userId: string,
  tenantId: string,
): Promise<{ ok: boolean }> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) return { ok: false };
  const col = qid(field);
  await pgTx(async ({ all, run }) => {
    // Cascade: strip deleted field from displayFields of any linked fields in
    // this tenant (cross-tenant linked refs are impossible by construction).
    const linkedRefs = await all<{ dim_id: string; field: string; field_config: string }>(
      `SELECT dim_id, field, field_config FROM ${pg("dimension_field")}
       WHERE type = 'linked'
       AND tenant_id = $3
       AND field_config::jsonb @> $1::jsonb
       AND field_config::jsonb -> 'displayFields' ? $2`,
      [JSON.stringify({ targetDimId: dimId }), field, tenantId],
    );
    for (const ref of linkedRefs) {
      const cfg = JSON.parse(ref.field_config) as { targetDimId: string; displayFields: string[] };
      const newDfs = cfg.displayFields.filter((df) => df !== field);
      await run(
        `UPDATE ${pg("dimension_field")} SET field_config = $1 WHERE dim_id = $2 AND field = $3 AND tenant_id = $4`,
        [JSON.stringify({ ...cfg, displayFields: newDfs }), ref.dim_id, ref.field, tenantId],
      );
    }
    await run(
      `DELETE FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2 AND tenant_id = $3`,
      [dimId, field, tenantId],
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
  dimId: string,
  field: string,
  label: string,
  color: PaletteName | null = null,
  opts: { silent?: boolean } = {},
  userId: string,
  tenantId: string,
): Promise<{ options: OptionDef[] } | null> {
  const f = (await listFields(dimId, tenantId)).find((x) => x.field === field);
  if (!f || f.type !== "select") return null;
  const existing = f.options ?? [];
  if (existing.some((o) => o.label === label)) return { options: existing };
  const next: OptionDef[] = [...existing, { label, color }];
  // Preserve any other keys in field_config (e.g. rules) by reading the raw
  // stored value and merging only the options key.
  const rawRow = await pgGet<{ field_config: string | null }>(
    `SELECT field_config FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2 AND tenant_id = $3`,
    [dimId, field, tenantId],
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
    `UPDATE ${pg("dimension_field")} SET field_config = $1 WHERE dim_id = $2 AND field = $3 AND tenant_id = $4`,
    [JSON.stringify({ ...existingCfg, options: next }), dimId, field, tenantId],
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

/** Set one enrichment field on a canonical record (only registered fields),
 *  cast to the field's declared type. */
export async function setFieldValue(
  dimId: string,
  key: string,
  field: string,
  value: string | null,
  tenantId: string,
): Promise<void> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) return;
  const f = (await listFields(dimId, tenantId)).find((x) => x.field === field);
  if (!f) return;
  const col = qid(field);
  const keyc = qid(m.keyCol);
  const empty = value == null || value.trim() === "";
  if (f.type === "number") {
    const n = empty ? null : Number(value);
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [
      Number.isFinite(n as number) ? n : null,
      key,
    ]);
  } else if (f.type === "boolean") {
    const b = value === "true" ? true : value === "false" ? false : null;
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [b, key]);
  } else if (f.type === "date") {
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1::date WHERE ${keyc} = $2`, [
      empty ? null : value!.trim(),
      key,
    ]);
  } else if (f.type === "linked") {
    let fkValue: string | null = empty ? null : value!.trim();
    if (fkValue !== null && f.referencedDimId) {
      const tm = await dimMeta(f.referencedDimId, tenantId);
      if (tm) {
        const exists = await pgGet(
          `SELECT 1 FROM ${cq(tm.dimTable)} WHERE ${qid(tm.keyCol)} = $1`,
          [fkValue],
        );
        if (!exists) fkValue = null;
      }
    }
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [fkValue, key]);
  } else {
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [
      empty ? null : value,
      key,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Dimension meta update
// ---------------------------------------------------------------------------

export interface UpdateDimensionMetaInput {
  orderingMode?: "derived" | "manual";
  description?: string | null;
  color?: string | null;
  ownerUserId?: string | null;
}

export async function updateDimensionMeta(
  dimId: string,
  patch: UpdateDimensionMetaInput,
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
     FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!current) throw new AppError("NOT_FOUND", `dimension ${dimId} not found`, 404);

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
  const vals: unknown[] = [dimId, tenantId];
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
      `UPDATE ${pg("dimension")} SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2`,
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
        tableId: dimId,
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
        tableId: dimId,
        tenantId,
        metadata: { from: "manual", to: "derived", nulledRows: result?.n ?? 0 },
      });
    }
  }

  return {
    id: dimId,
    orderingMode: modeChanges ? patch.orderingMode! : current.orderingMode,
    description:
      patch.description !== undefined ? patch.description?.trim() || null : current.description,
    color: patch.color !== undefined ? (patch.color ?? null) : current.color,
  };
}

// ---------------------------------------------------------------------------
// Dimension deletion
// ---------------------------------------------------------------------------

/** Permanently removes a table: metadata rows, the dim_/map_ Postgres tables,
 *  and the dimension row. Audit and outbound_event rows are kept — history
 *  outlives the table — and a final audit entry records the deletion. */
export async function deleteDimension(
  id: string,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const dim = await pgGet<{ id: string; label: string; dim_table: string; map_table: string }>(
    `SELECT id, label, dim_table, map_table FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if (!dim) return false;
  // Use to_regclass to check table existence before counting — avoids
  // poisoning the transaction with a missing-table error (error code 42P01
  // inside a transaction leaves it in an aborted state for all later queries).
  const exists = await pgGet<{ r: string | null }>(`SELECT to_regclass($1) AS r`, [dim.dim_table]);
  const count = exists?.r
    ? await pgGet<{ n: number }>(`SELECT count(*)::int AS n FROM ${cq(dim.dim_table)}`)
    : { n: 0 };
  const tenantSweeps = [
    "dimension_source",
    "dimension_field",
    "draft",
    "source_stat",
    "ai_hint_cache",
    "canonical_version",
  ];
  for (const t of tenantSweeps) {
    await pgRun(`DELETE FROM ${pg(t)} WHERE dim_id = $1 AND tenant_id = $2`, [id, tenantId]);
  }
  // user_grid_layout has no tenant_id column — scope to the calling tenant's members
  await pgRun(
    `DELETE FROM ${pg("user_grid_layout")} WHERE dim_id = $1
       AND user_id IN (SELECT user_id FROM ${pg("tenant_member")} WHERE tenant_id = $2)`,
    [id, tenantId],
  );
  await pgRun(`DROP TABLE IF EXISTS ${cq(dim.dim_table)}`);
  await pgRun(`DROP TABLE IF EXISTS ${cq(dim.map_table)}`);
  await pgRun(`DELETE FROM ${pg("dimension")} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  const dimTableShort = dim.dim_table.includes(".")
    ? dim.dim_table.split(".").pop()!
    : dim.dim_table;
  const mapTableShort = dim.map_table.includes(".")
    ? dim.map_table.split(".").pop()!
    : dim.map_table;
  await appendAuditAs(
    userId,
    "Deleted table",
    `${dim.label} — ${count?.n ?? 0} records; dropped ${dimTableShort} + ${mapTableShort}`,
    { tableId: id, tenantId },
  );
  return true;
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

export async function rebalanceDimPositions(
  dimId: string,
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
      tableId: dimId,
      tenantId,
      metadata: { rebalancedRows: rows.length, trigger },
    });
  }
  return rows.length;
}

export async function addCanonicalOneAt(
  dimId: string,
  label: string,
  key: string | undefined,
  insertAt: { anchor: string; direction: "above" | "below" },
  userId: string,
  tenantId: string,
): Promise<void> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) return;
  if (m.orderingMode !== "manual") {
    return addCanonicalOne(dimId, label, key, userId, tenantId);
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
    await rebalanceDimPositions(dimId, m, userId, tenantId, "collision");
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
    await tx.run(
      `INSERT INTO ${DIMT} (${KC}, label, position) VALUES ($1, $2, $3)
       ON CONFLICT (${KC}) DO NOTHING`,
      [k, label, String(newPos!)],
    );
    await seedVersionRow(tx, dimId, k, userId, tenantId);
  });

  await appendAuditAs(userId, "Inserted canonical at position", `${label} (${k})`, {
    tableId: dimId,
    rowKey: k,
    tenantId,
    metadata: { key: k, anchor: insertAt.anchor, direction: insertAt.direction },
  });
}

/** Move a canonical row to a new position in manual-ordering mode.
 *  before / after are the keys of the immediate neighbours in the desired
 *  final order (null = move to top/bottom). */
export async function reorderCanonicalRow(
  dimId: string,
  rowKey: string,
  before: string | null | undefined,
  after: string | null | undefined,
  userId: string,
  tenantId: string,
): Promise<{ position: string }> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) throw new AppError("NOT_FOUND", `dimension ${dimId} not found`, 404);
  if (m.orderingMode !== "manual") {
    throw new AppError("CONFLICT", "dimension is not in manual ordering mode", 409);
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

    await appendAuditAs(userId, "Reordered canonical", rowKey, {
      tableId: dimId,
      rowKey,
      tenantId,
      metadata: { key: rowKey, before: before ?? null, after: after ?? null },
    });

    return { position: String(newPos) };
  });
}

/** The raw variants that resolve to a canonical key — the lineage "receipt". */
export async function listVariants(
  dimId: string,
  key: string,
  tenantId: string,
): Promise<string[]> {
  const m = await dimMeta(dimId, tenantId);
  if (!m) return [];
  const rows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1 ORDER BY raw LIMIT 300`,
    [key],
  );
  return rows.map((r) => r.raw);
}
