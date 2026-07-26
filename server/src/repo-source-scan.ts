import { pgTxRaw, pgAll } from "./pg.ts";
import { cq, qid } from "./repo-shared.ts";
import { clusterScanRows, type ScanValueCluster } from "./cluster-values.ts";

export interface ScanOccurrence {
  raw: string;
  table: string;
  column: string;
  rows: number;
}

export interface MaterializeOpts {
  occurrences: readonly ScanOccurrence[];
  scannedAt: Date;
}

/** Chunk an INSERT into batches to stay under Postgres bind-param limit (65535).
 *  Expects an array of row-param arrays (each inner array is one row's positional params).
 *  Generates placeholders and executes in chunks of 500 rows. */
async function bulkInsertChunked(
  tx: any,
  prefix: string,
  rowsParams: unknown[][],
  paramsPerRow: number,
  conflictClause: string,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rowsParams.length; i += CHUNK) {
    const chunk = rowsParams.slice(i, i + CHUNK);
    const ph = chunk
      .map(
        (_, r) =>
          `(${Array.from({ length: paramsPerRow }, (_, k) => `$${r * paramsPerRow + k + 1}`).join(", ")})`,
      )
      .join(", ");
    const flat = chunk.flat();
    await tx.run(`${prefix} VALUES ${ph} ${conflictClause}`, flat);
  }
}

/** Replace this refTable's materialized scan values atomically. Per-source
 *  occurrences keep provenance; source_scan_value rolls up by case-folded raw. */
export async function materializeSourceScanValues(
  refTableId: string,
  tenantId: string,
  opts: MaterializeOpts,
): Promise<void> {
  const byLower = new Map<string, { raw: string; total: number }>();
  for (const o of opts.occurrences) {
    const lower = o.raw.toLowerCase();
    const e = byLower.get(lower);
    if (e) e.total += o.rows;
    else byLower.set(lower, { raw: o.raw, total: o.rows });
  }

  // Uses pgTxRaw (not pgTxScoped): repo writers across the codebase rely on the
  // connection-role RLS bypass; per-row tenant_id is enforced explicitly via
  // the WHERE clauses below.
  await pgTxRaw(async (tx) => {
    await tx.run(
      `DELETE FROM zugzug_app.source_scan_occurrence WHERE tenant_id = $1 AND reference_table_id = $2`,
      [tenantId, refTableId],
    );
    await tx.run(
      `DELETE FROM zugzug_app.source_scan_value      WHERE tenant_id = $1 AND reference_table_id = $2`,
      [tenantId, refTableId],
    );

    if (byLower.size > 0) {
      const rowsParams: unknown[][] = [];
      for (const [lower, v] of byLower) {
        rowsParams.push([tenantId, refTableId, v.raw, lower, v.total, opts.scannedAt]);
      }
      await bulkInsertChunked(
        tx,
        `INSERT INTO zugzug_app.source_scan_value
           (tenant_id, reference_table_id, raw, raw_lower, total_rows, scanned_at)`,
        rowsParams,
        6,
        "",
      );
    }

    if (opts.occurrences.length > 0) {
      const rowsParams: unknown[][] = [];
      for (const o of opts.occurrences) {
        rowsParams.push([tenantId, refTableId, o.raw.toLowerCase(), o.table, o.column, o.rows]);
      }
      await bulkInsertChunked(
        tx,
        `INSERT INTO zugzug_app.source_scan_occurrence
           (tenant_id, reference_table_id, raw_lower, table_name, column_name, rows)`,
        rowsParams,
        6,
        `ON CONFLICT (tenant_id, reference_table_id, raw_lower, table_name, column_name)
           DO UPDATE SET rows = EXCLUDED.rows`,
      );
    }
  });
}

export interface SourceScanScalars {
  refTableId: string;
  totalDistinct: number;
  mappedCount: number;
  newCount: number;
  /** SUM(total_rows) for values without a row in map_<refTable>. */
  unmappedRowsTotal: number;
  /** SUM(total_rows) for values already mapped. */
  mappedRowsTotal: number;
  scannedAt: Date | null;
}

/** Per-refTable scalar counts and last-scan timestamp. One row per refTable that has
 *  been scanned at least once. Loops in JS because map_<refTable> is dynamic. */
export async function getSourceScanScalars(tenantId: string): Promise<SourceScanScalars[]> {
  const refTables = await pgAll<{ refTableId: string; mapTable: string }>(
    `SELECT id AS "refTableId", map_table AS "mapTable"
       FROM zugzug_app.reference_table WHERE tenant_id = $1`,
    [tenantId],
  );
  const mapByDim = new Map(refTables.map((d) => [d.refTableId, d.mapTable]));

  const rows = await pgAll<{
    refTableId: string;
    total: number;
    rowsTotal: number;
    scannedAt: Date | null;
  }>(
    `SELECT reference_table_id AS "refTableId",
            COUNT(*)::bigint           AS total,
            COALESCE(SUM(total_rows), 0)::bigint AS "rowsTotal",
            MAX(scanned_at)            AS "scannedAt"
       FROM zugzug_app.source_scan_value
       WHERE tenant_id = $1
       GROUP BY reference_table_id`,
    [tenantId],
  );

  // Mapped counts join source_scan_value against each refTable's own physical
  // map_<table>, so it cannot be a single GROUP BY. Fold the per-table loop
  // into one UNION ALL round-trip instead of N sequential queries (#153).
  // Table names come from the trusted refTable registry, never user input.
  const mappedById = new Map<string, { mapped: number; mappedRows: number }>();
  const withMap = rows.filter((r) => mapByDim.get(r.refTableId));
  if (withMap.length > 0) {
    const sql = withMap
      .map(
        (r, i) => `SELECT $${i + 2}::text AS id,
                COUNT(*)::bigint AS n,
                COALESCE(SUM(v.total_rows), 0)::bigint AS rows
           FROM zugzug_app.source_scan_value v
           JOIN ${cq(mapByDim.get(r.refTableId)!)} m
             ON m.tenant_id = v.tenant_id AND LOWER(m.raw) = v.raw_lower
          WHERE v.tenant_id = $1 AND v.reference_table_id = $${i + 2}`,
      )
      .join(" UNION ALL ");
    const mrows = await pgAll<{ id: string; n: number; rows: number }>(sql, [
      tenantId,
      ...withMap.map((r) => r.refTableId),
    ]);
    for (const m of mrows) {
      mappedById.set(m.id, { mapped: Number(m.n), mappedRows: Number(m.rows) });
    }
  }

  const out: SourceScanScalars[] = [];
  for (const r of rows) {
    const mapped = mappedById.get(r.refTableId)?.mapped ?? 0;
    const mappedRows = mappedById.get(r.refTableId)?.mappedRows ?? 0;
    const rowsTotal = Number(r.rowsTotal);
    out.push({
      refTableId: r.refTableId,
      totalDistinct: Number(r.total),
      mappedCount: mapped,
      newCount: Number(r.total) - mapped,
      mappedRowsTotal: mappedRows,
      unmappedRowsTotal: rowsTotal - mappedRows,
      scannedAt: r.scannedAt,
    });
  }
  return out;
}

export interface ScanValueRow {
  raw: string;
  totalRows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}

export interface PageOpts {
  filter: "new" | "mapped" | "all";
  limit: number;
  after?: string | null;
  q?: string | null;
}

export interface ValuesPage {
  items: ScanValueRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

function encodeCursor(totalRows: number, rawLower: string): string {
  return Buffer.from(JSON.stringify([totalRows, rawLower])).toString("base64url");
}
function decodeCursor(c: string): [number, string] | null {
  try {
    const j = JSON.parse(Buffer.from(c, "base64url").toString());
    return Array.isArray(j) && typeof j[0] === "number" && typeof j[1] === "string"
      ? [j[0], j[1]]
      : null;
  } catch {
    return null;
  }
}

/** One page of refTable values, sorted by total_rows desc, raw_lower asc. Cursor
 *  is the (total_rows, raw_lower) lex tuple — stable because raw_lower is
 *  PK-unique within a refTable. */
export async function getSourceScanValuesPage(
  tenantId: string,
  refTableId: string,
  opts: PageOpts,
): Promise<ValuesPage> {
  const limit = Math.min(500, Math.max(1, opts.limit));
  const refTable = await pgAll<{ mapTable: string; dimTable: string; keyCol: string }>(
    `SELECT map_table AS "mapTable", dim_table AS "dimTable", key_col AS "keyCol"
       FROM zugzug_app.reference_table WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!refTable.length) return { items: [], hasMore: false, nextCursor: null };
  const { mapTable, dimTable, keyCol } = refTable[0];

  const params: unknown[] = [tenantId, refTableId];
  let where = `v.tenant_id = $1 AND v.reference_table_id = $2`;
  if (opts.q && opts.q.trim()) {
    params.push(`%${opts.q.trim().toLowerCase()}%`);
    where += ` AND v.raw_lower ILIKE $${params.length}`;
  }
  if (opts.filter === "new") {
    where += ` AND m.${qid(keyCol)} IS NULL`;
  } else if (opts.filter === "mapped") {
    where += ` AND m.${qid(keyCol)} IS NOT NULL`;
  }
  if (opts.after) {
    const c = decodeCursor(opts.after);
    if (c) {
      params.push(c[0], c[0], c[1]);
      where += ` AND (v.total_rows < $${params.length - 2}
                  OR (v.total_rows = $${params.length - 1} AND v.raw_lower > $${params.length}))`;
    }
  }
  params.push(limit + 1);

  const rows = await pgAll<{
    raw: string;
    raw_lower: string;
    total_rows: number;
    mapped_key: string | null;
    mapped_label: string | null;
  }>(
    `SELECT v.raw, v.raw_lower, v.total_rows,
            m.${qid(keyCol)} AS mapped_key,
            d.label          AS mapped_label
       FROM zugzug_app.source_scan_value v
       LEFT JOIN ${cq(mapTable)} m
         ON m.tenant_id = v.tenant_id AND LOWER(m.raw) = v.raw_lower
       LEFT JOIN ${cq(dimTable)} d
         ON d.${qid(keyCol)} = m.${qid(keyCol)}
       WHERE ${where}
       ORDER BY v.total_rows DESC, v.raw_lower ASC
       LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const lowers = items.map((r) => r.raw_lower);

  const occs = lowers.length
    ? await pgAll<{ raw_lower: string; table_name: string; column_name: string; rows: number }>(
        `SELECT raw_lower, table_name, column_name, rows
           FROM zugzug_app.source_scan_occurrence
           WHERE tenant_id = $1 AND reference_table_id = $2 AND raw_lower = ANY($3)`,
        [tenantId, refTableId, lowers],
      )
    : [];
  const occByLower = new Map<string, { table: string; column: string; rows: number }[]>();
  for (const o of occs) {
    const arr = occByLower.get(o.raw_lower) ?? [];
    arr.push({ table: o.table_name, column: o.column_name, rows: Number(o.rows) });
    occByLower.set(o.raw_lower, arr);
  }

  const out: ScanValueRow[] = items.map((r) => ({
    raw: r.raw,
    totalRows: Number(r.total_rows),
    isMapped: r.mapped_key !== null,
    mappedLabel: r.mapped_label,
    occurrences: occByLower.get(r.raw_lower) ?? [],
  }));

  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(Number(last.total_rows), last.raw_lower) : null;

  return { items: out, hasMore, nextCursor };
}

/** Options for the cluster feed. `cap` bounds how many values are pulled into
    memory for clustering (default 5000); the omitted long tail is reported via
    `truncated`. */
export interface ClusterFeedOpts {
  filter: "new" | "mapped" | "all";
  cap?: number;
}

/**
 * Fetch a refTable's scan values worst-impact-first by looping the existing
 * paginated `getSourceScanValuesPage` until it is exhausted or `cap` is reached.
 * Reuses the tested query + cursor + occurrence logic — no new SQL. Returns the
 * (possibly capped) rows and whether more existed beyond the cap.
 */
export async function getSourceScanValuesAll(
  tenantId: string,
  refTableId: string,
  opts: ClusterFeedOpts,
): Promise<{ rows: ScanValueRow[]; truncated: boolean }> {
  const cap = opts.cap ?? 5000;
  const rows: ScanValueRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await getSourceScanValuesPage(tenantId, refTableId, {
      filter: opts.filter,
      limit: 500,
      after,
    });
    rows.push(...page.items);
    if (rows.length >= cap) {
      return { rows: rows.slice(0, cap), truncated: page.hasMore || rows.length > cap };
    }
    if (!page.hasMore || !page.nextCursor) {
      return { rows, truncated: false };
    }
    after = page.nextCursor;
  }
}

/** The focused mapper's payload: complete clusters worst-first, plus coverage. */
export interface RefTableClusterFeed {
  clusters: ScanValueCluster[];
  coverage: { resolvedRows: number; atRiskRows: number; pct: number };
  truncated: boolean;
}

/**
 * Fetch a refTable's values (capped, worst-first), cluster the whole set so
 * every family is complete, and attach coverage. Coverage comes from the
 * authoritative whole-refTable scalars (not the possibly-truncated rows), so it
 * stays correct regardless of the cap.
 */
export async function getRefTableClusters(
  tenantId: string,
  refTableId: string,
  opts: ClusterFeedOpts,
): Promise<RefTableClusterFeed> {
  const { rows, truncated } = await getSourceScanValuesAll(tenantId, refTableId, opts);
  const clusters = clusterScanRows(rows);
  const scalars = (await getSourceScanScalars(tenantId)).find((s) => s.refTableId === refTableId);
  const resolvedRows = scalars?.mappedRowsTotal ?? 0;
  const atRiskRows = scalars?.unmappedRowsTotal ?? 0;
  const denom = resolvedRows + atRiskRows;
  const pct = denom > 0 ? Math.round((resolvedRows / denom) * 100) : 100;
  return { clusters, coverage: { resolvedRows, atRiskRows, pct }, truncated };
}
