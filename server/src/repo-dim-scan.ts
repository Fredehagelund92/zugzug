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
      const params: unknown[] = [];
      const ph: string[] = [];
      let i = 0;
      for (const [lower, v] of byLower) {
        params.push(tenantId, dimId, v.raw, lower, v.total, opts.scannedAt);
        ph.push(`($${++i}, $${++i}, $${++i}, $${++i}, $${++i}, $${++i})`);
      }
      await tx.run(
        `INSERT INTO zugzug_app.dim_scan_value
           (tenant_id, dim_id, raw, raw_lower, total_rows, scanned_at)
         VALUES ${ph.join(", ")}`,
        params,
      );
    }

    if (opts.occurrences.length > 0) {
      const params: unknown[] = [];
      const ph: string[] = [];
      let j = 0;
      for (const o of opts.occurrences) {
        params.push(tenantId, dimId, o.raw.toLowerCase(), o.table, o.column, o.rows);
        ph.push(`($${++j}, $${++j}, $${++j}, $${++j}, $${++j}, $${++j})`);
      }
      await tx.run(
        `INSERT INTO zugzug_app.dim_scan_occurrence
           (tenant_id, dim_id, raw_lower, table_name, column_name, rows)
         VALUES ${ph.join(", ")}
         ON CONFLICT (tenant_id, dim_id, raw_lower, table_name, column_name)
           DO UPDATE SET rows = EXCLUDED.rows`,
        params,
      );
    }
  });
}
