import { pgTxRaw } from "./pg.ts";

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

/** Replace this dim's materialized scan values atomically. Per-source
 *  occurrences keep provenance; dim_scan_value rolls up by case-folded raw. */
export async function materializeDimScanValues(
  dimId: string,
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
      `DELETE FROM zugzug_app.dim_scan_occurrence WHERE tenant_id = $1 AND dim_id = $2`,
      [tenantId, dimId],
    );
    await tx.run(
      `DELETE FROM zugzug_app.dim_scan_value      WHERE tenant_id = $1 AND dim_id = $2`,
      [tenantId, dimId],
    );

    if (byLower.size > 0) {
      const rowsParams: unknown[][] = [];
      for (const [lower, v] of byLower) {
        rowsParams.push([tenantId, dimId, v.raw, lower, v.total, opts.scannedAt]);
      }
      await bulkInsertChunked(
        tx,
        `INSERT INTO zugzug_app.dim_scan_value
           (tenant_id, dim_id, raw, raw_lower, total_rows, scanned_at)`,
        rowsParams,
        6,
        "",
      );
    }

    if (opts.occurrences.length > 0) {
      const rowsParams: unknown[][] = [];
      for (const o of opts.occurrences) {
        rowsParams.push([tenantId, dimId, o.raw.toLowerCase(), o.table, o.column, o.rows]);
      }
      await bulkInsertChunked(
        tx,
        `INSERT INTO zugzug_app.dim_scan_occurrence
           (tenant_id, dim_id, raw_lower, table_name, column_name, rows)`,
        rowsParams,
        6,
        `ON CONFLICT (tenant_id, dim_id, raw_lower, table_name, column_name)
           DO UPDATE SET rows = EXCLUDED.rows`,
      );
    }
  });
}
