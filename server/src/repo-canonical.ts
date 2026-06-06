/* repo-canonical.ts — dimension registry + canonical CRUD + field/column management.
 *
 * All data lives in Postgres (dim_/map_ tables in the canonical schema +
 * the app-state dimension/dimension_field tables). Warehouse (DuckDB) is
 * touched only in getDimension (to resolve live names for external_id dims). */

import {
  type DimensionMeta,
  type MappingDimension,
  type CanonicalValue,
  type MappingValue,
  type FieldDef,
  type OptionDef,
  type PaletteName,
  type SourceOccurrence,
  type NumberFormat,
  PALETTE_NAMES,
  slug,
  qid,
  cq,
  whTable,
  liveSources,
  occUnion,
  dimMeta,
  parseFieldConfig,
  all,
  pgAll,
  pgGet,
  pgRun,
  pgTx,
  env,
  pg,
} from "./repo-shared.ts";
import { appendAuditAs } from "./repo-meta.ts";

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
};

/* ---- dimension registry (Postgres) + canonical tables ---- */
export async function listDimensions(): Promise<DimensionMeta[]> {
  const metas = await pgAll<Omit<DimensionMeta, "rows">>(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind"
     FROM ${pg("dimension")} ORDER BY label`,
  );
  const counts = await Promise.all(
    metas.map((m) =>
      pgGet<{ n: number }>(`SELECT count(*)::int AS n FROM ${cq(m.mapTable)}`).catch(() => null),
    ),
  );

  return metas.map((m, i) => ({ ...m, rows: Number(counts[i]?.n ?? 0) }));
}

export async function getDimension(id: string): Promise<MappingDimension | null> {
  const meta = await pgGet<
    Omit<DimensionMeta, "rows"> & {
      nameTable: string | null;
      nameIdCol: string | null;
      nameCol: string | null;
      description: string | null;
      color: string | null;
    }
  >(
    `SELECT id, label AS dimension, dim_table AS "dimTable", map_table AS "mapTable",
            key_col AS "keyCol", COALESCE(key_kind, 'slug') AS "keyKind",
            name_table AS "nameTable", name_id_col AS "nameIdCol", name_col AS "nameCol",
            description, color
     FROM ${pg("dimension")} WHERE id = $1`,
    [id],
  );
  if (!meta) return null;

  const k = qid(meta.keyCol);
  const fields = await listFields(id);
  const fieldCols = fields
    .map((f) => `CAST(d.${qid(f.field)} AS VARCHAR) AS ${qid(f.field)}`)
    .join(", ");

  const liveName =
    meta.keyKind === "external_id" &&
    env.attachWarehouse &&
    !!meta.nameTable &&
    !!meta.nameIdCol &&
    !!meta.nameCol;

  // Fetch canonical rows from Postgres
  let canonRows: Record<string, unknown>[];
  if (meta.keyKind === "external_id") {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, NULL AS label, true AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.${k}`,
    );
  } else {
    canonRows = await pgAll<Record<string, unknown>>(
      `SELECT d.${k} AS key, d.label, false AS unresolved${fields.length ? ", " + fieldCols : ""},
              COALESCE(v.n, 0)::int AS variants
       FROM ${cq(meta.dimTable)} d
       LEFT JOIN (SELECT ${k} AS gk, count(*)::int AS n FROM ${cq(meta.mapTable)} GROUP BY 1) v ON v.gk = d.${k}
       ORDER BY variants DESC, d.label`,
    );
  }

  // For external_id dims with warehouse attached: resolve names from MotherDuck
  if (liveName) {
    const nameRows = await all<{ id: string; nm: string }>(
      `SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id,
              CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm
       FROM ${whTable(meta.nameTable!)}`,
    ).catch(() => [] as { id: string; nm: string }[]);
    const nameMap = new Map(nameRows.map((r) => [r.id, r.nm]));
    for (const r of canonRows) {
      const key = String(r.key);
      r.label = nameMap.get(key) ?? null;
      r.unresolved = !nameMap.has(key);
    }
  }

  const canonical = canonRows.map((r) => ({
    key: String(r.key),
    label: r.label == null ? String(r.key) : String(r.label),
    unresolved: !!r.unresolved,
    variants: Number(r.variants),
    fields: Object.fromEntries(
      fields.map((f) => [f.field, r[f.field] == null ? null : String(r[f.field])]),
    ),
  }));

  const rowsRow = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(meta.mapTable)}`,
  ).catch(() => null);
  const values = await scanValues(id, meta);
  const { nameTable, nameIdCol, nameCol, description, color, ...metaOut } = meta;
  const safeColor =
    typeof color === "string" && (PALETTE_NAMES as readonly string[]).includes(color)
      ? (color as PaletteName)
      : null;
  return {
    ...metaOut,
    description: description ?? null,
    color: safeColor,
    rows: Number(rowsRow?.n ?? 0),
    canonical,
    values,
    fields,
  };
}

/** Distinct warehouse values for a dimension WITH provenance, tagged mapped/new
 *  by cross-referencing the Postgres crosswalk. Two-fetch + JS pattern. */
async function scanValues(
  dimId: string,
  meta: Omit<DimensionMeta, "rows"> & {
    nameTable?: string | null;
    nameIdCol?: string | null;
    nameCol?: string | null;
  },
): Promise<MappingValue[]> {
  let sources = await liveSources(dimId);
  if (meta.keyKind === "external_id" && meta.nameTable && meta.nameCol) {
    sources = sources.filter((s) => !(s.table === meta.nameTable && s.column === meta.nameCol));
  }
  if (!sources.length) return [];

  // 1. Warehouse: distinct raw values with provenance + row counts
  const occRows = await all<{ raw: string; tbl: string; col: string; rows: bigint }>(
    occUnion(sources),
  ).catch(() => [] as { raw: string; tbl: string; col: string; rows: bigint }[]);
  if (!occRows.length) return [];

  // Collapse to one row per raw value (UNION ALL → aggregate in JS)
  const occMap = new Map<string, { tbl: string; col: string; rows: number }[]>();
  for (const r of occRows) {
    const key = r.raw.toLowerCase();
    const entry = occMap.get(key) ?? [];
    entry.push({ tbl: r.tbl, col: r.col, rows: Number(r.rows) });
    occMap.set(key, entry);
  }
  // Keep insertion order (first raw string wins as the display value)
  const raws = new Map<string, string>(); // lowercase → original case
  for (const r of occRows) {
    if (!raws.has(r.raw.toLowerCase())) raws.set(r.raw.toLowerCase(), r.raw);
  }

  // 2. Postgres: all mapped raws for this dimension
  const mappedRows = await pgAll<{ raw: string; key: string }>(
    `SELECT raw, ${qid(meta.keyCol)} AS key FROM ${cq(meta.mapTable)}`,
  ).catch(() => [] as { raw: string; key: string }[]);
  const mappedSet = new Map<string, string>(); // lowercase raw → canonical key
  for (const r of mappedRows) mappedSet.set(r.raw.toLowerCase(), r.key);

  // 3. Optionally fetch live canonical names (external_id + warehouse attached)
  const liveName =
    meta.keyKind === "external_id" &&
    env.attachWarehouse &&
    !!meta.nameTable &&
    !!meta.nameIdCol &&
    !!meta.nameCol;
  const nameMap = new Map<string, string>(); // canonical key → display name
  if (liveName) {
    const nameRows = await all<{ id: string; nm: string }>(
      `SELECT CAST(${qid(meta.nameIdCol!)} AS VARCHAR) AS id,
              CAST(${qid(meta.nameCol!)} AS VARCHAR) AS nm
       FROM ${whTable(meta.nameTable!)}`,
    ).catch(() => [] as { id: string; nm: string }[]);
    for (const r of nameRows) nameMap.set(r.id, r.nm);
  }

  // 4. Postgres: all canonical labels (slug dims)
  const labelMap = new Map<string, string>(); // canonical key → label
  if (!liveName && meta.keyKind !== "external_id") {
    const dimRows = await pgAll<{ key: string; label: string }>(
      `SELECT ${qid(meta.keyCol)} AS key, label FROM ${cq(meta.dimTable)}`,
    ).catch(() => [] as { key: string; label: string }[]);
    for (const r of dimRows) labelMap.set(r.key, r.label);
  }

  // 5. Build result (unmapped first, then mapped; sorted by row count desc within each group)
  const results: MappingValue[] = [];
  for (const [lowerRaw, raw] of raws) {
    const srcs: SourceOccurrence[] = (occMap.get(lowerRaw) ?? []).map((o) => ({
      table: o.tbl,
      column: o.col,
      rows: o.rows,
    }));
    const canonKey = mappedSet.get(lowerRaw) ?? null;
    const status: "mapped" | "new" = canonKey ? "mapped" : "new";
    const current = canonKey
      ? liveName
        ? (nameMap.get(canonKey) ?? null)
        : (labelMap.get(canonKey) ?? null)
      : null;
    results.push({ value: raw, status, current, suggestion: null, confidence: 0, sources: srcs });
  }
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === "new" ? -1 : 1;
    const aRows = a.sources.reduce((s, x) => s + x.rows, 0);
    const bRows = b.sources.reduce((s, x) => s + x.rows, 0);
    return bRows - aRows;
  });
  return results.slice(0, 500);
}

/** Create a dimension: register it + provision dim_/map_ (Postgres) + register
 *  its warehouse sources. Idempotent on the id. For key_kind 'external_id' the
 *  dim_ label is nullable (names are resolved live from the warehouse, not stored). */
export async function addDimension(
  name: string,
  sources: { table: string; column: string }[] = [],
  opts: { keyKind?: "slug" | "external_id"; silent?: boolean } = {},
  userId: string,
): Promise<string> {
  const id = slug(name);
  if (!id) return id;
  const keyKind = opts.keyKind === "external_id" ? "external_id" : "slug";
  const dimTable = `${env.canonicalSchema}.dim_${id}`;
  const mapTable = `${env.canonicalSchema}.map_${id}`;
  const keyCol = `${id}_code`;
  const existing = await pgGet(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
  if (!existing) {
    const labelDdl = keyKind === "external_id" ? "label VARCHAR" : "label VARCHAR NOT NULL";
    await pgRun(
      `CREATE TABLE IF NOT EXISTS ${cq(dimTable)} (${qid(keyCol)} VARCHAR PRIMARY KEY, ${labelDdl})`,
    );
    await pgRun(
      `CREATE TABLE IF NOT EXISTS ${cq(mapTable)} (raw VARCHAR PRIMARY KEY, ${qid(keyCol)} VARCHAR NOT NULL)`,
    );
    await pgRun(
      `INSERT INTO ${pg("dimension")} (id, label, dim_table, map_table, key_col, key_kind, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, current_timestamp)`,
      [id, name.trim(), dimTable, mapTable, keyCol, keyKind],
    );
    if (!opts.silent) {
      await appendAuditAs(
        userId,
        "Created dimension",
        `${name.trim()} → dim_${id} + map_${id}${keyKind === "external_id" ? " (external-ID key)" : ""}`,
      );
    }
  }
  for (const s of sources) {
    await pgRun(
      `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column)
       VALUES ($1, $2, $3) ON CONFLICT (dim_id, source_table, source_column) DO NOTHING`,
      [id, s.table, s.column],
    );
  }
  return id;
}

/** Seed canonical values into a dimension's dim_ table (idempotent). */
export async function addCanonical(dimId: string, values: CanonicalValue[]): Promise<void> {
  const meta = await pgGet<{ dimTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM ${pg("dimension")} WHERE id = $1`,
    [dimId],
  );
  if (!meta) return;
  for (const v of values) {
    await pgRun(
      `INSERT INTO ${cq(meta.dimTable)} (${qid(meta.keyCol)}, label) VALUES ($1, $2)
       ON CONFLICT (${qid(meta.keyCol)}) DO NOTHING`,
      [v.key, v.label],
    );
  }
}

/** Add one canonical record (key derived from the label if not given). */
export async function addCanonicalOne(
  dimId: string,
  label: string,
  key: string | undefined,
  userId: string,
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const k = (key && slug(key)) || slug(label);
  if (!k) return;
  await pgRun(
    `INSERT INTO ${cq(m.dimTable)} (${qid(m.keyCol)}, label) VALUES ($1, $2)
     ON CONFLICT (${qid(m.keyCol)}) DO NOTHING`,
    [k, label],
  );
  await appendAuditAs(userId, "Added canonical", `${label} (${k})`);
}

/** Rename a canonical's display label (the key is stable). */
export async function renameCanonical(
  dimId: string,
  key: string,
  label: string,
  userId: string,
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;

  // Fetch old label before overwriting — needed for cache sync below.
  const oldRow = await pgGet<{ label: string }>(
    `SELECT label FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  ).catch(() => null);

  await pgRun(`UPDATE ${cq(m.dimTable)} SET label = $1 WHERE ${qid(m.keyCol)} = $2`, [label, key]);
  await appendAuditAs(userId, "Renamed canonical", `${key} → "${label}"`);

  // Keep ai_hint_cache consistent: update any hint that was pointing at the old label.
  if (oldRow?.label) {
    await pgRun(
      `UPDATE ${pg("ai_hint_cache")} SET suggestion = $1
       WHERE dim_id = $2 AND suggestion = $3`,
      [label, dimId, oldRow.label],
    ).catch(() => { /* table may not exist in older deploys */ });
  }
}

/** Merge loser canonicals into a survivor: re-point every crosswalk row, drop the
 *  losers' golden records, audit. The core MDM consolidation step. */
export async function mergeCanonical(
  dimId: string,
  survivor: string,
  losers: string[],
  userId: string,
): Promise<number> {
  const m = await dimMeta(dimId);
  if (!m) return 0;
  const key = qid(m.keyCol);
  const real = losers.filter((l) => l && l !== survivor);
  if (real.length === 0) return 0;

  await pgTx(async (tx) => {
    await tx.run(`UPDATE ${cq(m.mapTable)} SET ${key} = $1 WHERE ${key} = ANY($2::text[])`, [
      survivor,
      real,
    ]);
    await tx.run(`DELETE FROM ${cq(m.dimTable)} WHERE ${key} = ANY($1::text[])`, [real]);
  });

  await appendAuditAs(userId, "Merged canonical", `${real.join(", ")} → ${survivor}`);
  return real.length;
}

/** Retire a canonical — governed: refused while raw variants still map to it. */
export async function retireCanonical(
  dimId: string,
  key: string,
  userId: string,
): Promise<{ ok: boolean; variants: number }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false, variants: 0 };
  const v = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1`,
    [key],
  );
  const variants = Number(v?.n ?? 0);
  if (variants > 0) return { ok: false, variants };
  await pgRun(`DELETE FROM ${cq(m.dimTable)} WHERE ${qid(m.keyCol)} = $1`, [key]);
  await appendAuditAs(userId, "Retired canonical", key);
  return { ok: true, variants: 0 };
}

/* ---- enrichment fields (attribute columns on dim_) ---- */
export async function listFields(dimId: string): Promise<FieldDef[]> {
  const rows = await pgAll<{ field: string; label: string; type: string; field_config: string | null }>(
    `SELECT field, label, type, field_config FROM ${pg("dimension_field")} WHERE dim_id = $1 ORDER BY created_at`,
    [dimId],
  );
  return rows.map((r) => {
    const cfg = parseFieldConfig(r.type, r.field_config);
    return {
      field: r.field,
      label: r.label,
      type: r.type,
      ...cfg,
    };
  });
}

/** Add an attribute column to a dimension's dim_ table (ALTER TABLE). type ∈
 *  text | number | boolean | date | select. Select columns store an ordered
 *  option list in `dimension_field.options` (JSON); the dim_ column is VARCHAR
 *  (the value IS the option label). */
export async function addField(
  dimId: string,
  label: string,
  type: string = "text",
  options: OptionDef[] | undefined,
  opts: { silent?: boolean; numberFormat?: NumberFormat } = {},
  userId: string,
): Promise<{ field: string } | null> {
  const m = await dimMeta(dimId);
  if (!m) return null;
  const t = SQL_TYPE[type] ? type : type === "select" ? "select" : "text";
  const field = slug(label);
  if (!field || field === "label" || field === slug(m.keyCol)) return null;
  const sqlType = t === "select" ? "VARCHAR" : SQL_TYPE[t];
  await pgRun(`ALTER TABLE ${cq(m.dimTable)} ADD COLUMN IF NOT EXISTS ${qid(field)} ${sqlType}`);
  const optsJson =
    t === "select"
      ? JSON.stringify(options ?? [])
      : t === "number" && opts.numberFormat != null
        ? JSON.stringify(opts.numberFormat)
        : null;
  await pgRun(
    `INSERT INTO ${pg("dimension_field")} (dim_id, field, label, type, field_config, created_at)
     VALUES ($1, $2, $3, $4, $5, current_timestamp) ON CONFLICT (dim_id, field) DO NOTHING`,
    [dimId, field, label.trim(), t, optsJson],
  );
  if (!opts.silent) {
    await appendAuditAs(userId, "Added field", `${label.trim()} (${field}, ${t}) → ${m.dimTable}`);
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
): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  await pgRun(`UPDATE ${pg("dimension_field")} SET label = $1 WHERE dim_id = $2 AND field = $3`, [
    label,
    dimId,
    field,
  ]);
  await appendAuditAs(userId, "Renamed column", `${field} → "${label}"`);
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
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f) return { ok: false };
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
        `UPDATE ${pg("dimension_field")} SET type = $1, field_config = null WHERE dim_id = $2 AND field = $3`,
        [newType, dimId, field],
      );
    });
    await appendAuditAs(userId, "Changed column type", `${field} → ${newType}`);
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
      `UPDATE ${pg("dimension_field")} SET type = $1, field_config = $2 WHERE dim_id = $3 AND field = $4`,
      [
        newType,
        newType === "select"
          ? JSON.stringify(finalOptions ?? [])
          : newType === "number" && opts.numberFormat != null
            ? JSON.stringify(opts.numberFormat)
            : newType === "rating"
              ? JSON.stringify({ ratingMax: opts.ratingMax ?? 5 })
              : null,
        dimId,
        field,
      ],
    );
  });

  await appendAuditAs(
    userId,
    "Changed column type",
    `${field} → ${newType}${finalOptions ? ` (${finalOptions.length} options)` : ""}`,
  );
  return { ok: true, options: finalOptions };
}

/** Drop a column from the dim_ table AND its row in dimension_field, plus null
 *  the field on every row of the dim. Transactional — all-or-nothing. */
export async function deleteColumn(
  dimId: string,
  field: string,
  userId: string,
): Promise<{ ok: boolean }> {
  const m = await dimMeta(dimId);
  if (!m) return { ok: false };
  const col = qid(field);
  await pgTx(async ({ run }) => {
    await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2`, [
      dimId,
      field,
    ]);
    await run(`ALTER TABLE ${cq(m.dimTable)} DROP COLUMN IF EXISTS ${col}`);
  });
  await appendAuditAs(userId, "Deleted column", field);
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
): Promise<{ options: OptionDef[] } | null> {
  const f = (await listFields(dimId)).find((x) => x.field === field);
  if (!f || f.type !== "select") return null;
  const existing = f.options ?? [];
  if (existing.some((o) => o.label === label)) return { options: existing };
  const next: OptionDef[] = [...existing, { label, color }];
  await pgRun(`UPDATE ${pg("dimension_field")} SET field_config = $1 WHERE dim_id = $2 AND field = $3`, [
    JSON.stringify(next),
    dimId,
    field,
  ]);
  if (!opts.silent) {
    await appendAuditAs(
      userId,
      "Added field option",
      `${field} += "${label}"${color ? ` (${color})` : ""}`,
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
): Promise<void> {
  const m = await dimMeta(dimId);
  if (!m) return;
  const f = (await listFields(dimId)).find((x) => x.field === field);
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
  } else {
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [
      empty ? null : value,
      key,
    ]);
  }
}

/** The raw variants that resolve to a canonical key — the lineage "receipt". */
export async function listVariants(dimId: string, key: string): Promise<string[]> {
  const m = await dimMeta(dimId);
  if (!m) return [];
  const rows = await pgAll<{ raw: string }>(
    `SELECT raw FROM ${cq(m.mapTable)} WHERE ${qid(m.keyCol)} = $1 ORDER BY raw LIMIT 300`,
    [key],
  );
  return rows.map((r) => r.raw);
}
