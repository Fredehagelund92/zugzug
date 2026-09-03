export interface CommitOutcome {
  refTableId: string;
  refTableName: string;
  committed: number;
  rowsRecovered: number;
  error: string | null;
  /** Whether the publish also reached the warehouse copy. "failed" means the
   *  records are published in Zug Zug but the warehouse tables are stale —
   *  a partial outcome the publisher has to be told about. */
  warehouseSynced?: "n/a" | "synced" | "synced-additive" | "failed";
}

export function summarizeOutcomes(outcomes: CommitOutcome[]): {
  ok: boolean;
  committed: number;
  rowsRecovered: number;
  failed: CommitOutcome[];
  warehouseFailed: CommitOutcome[];
  message: string;
} {
  const failed = outcomes.filter((o) => o.error !== null);
  const warehouseFailed = outcomes.filter((o) => o.warehouseSynced === "failed");
  const committed = outcomes.reduce((n, o) => n + o.committed, 0);
  const rowsRecovered = outcomes.reduce((n, o) => n + o.rowsRecovered, 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (failed.length === 0) {
    const published = `✓ ${plural(committed, "change")} published · ${plural(rowsRecovered, "row")} recovered`;
    if (warehouseFailed.length === 0) {
      return { ok: true, committed, rowsRecovered, failed, warehouseFailed, message: published };
    }
    // The Postgres publish landed; the warehouse copy did not. Say so, or the
    // reader walks away believing dbt sees the new rows.
    const stale = warehouseFailed.map((f) => f.refTableName).join(", ");
    return {
      ok: true,
      committed,
      rowsRecovered,
      failed,
      warehouseFailed,
      message: `${published}, but the warehouse copy of ${stale} wasn't updated — publish again to retry.`,
    };
  }
  const names = failed.map((f) => `${f.refTableName} failed (${f.error})`).join("; ");
  return {
    ok: false,
    committed,
    rowsRecovered,
    failed,
    warehouseFailed,
    message: `Published ${plural(committed, "change")}, but ${names} — ${failed.length === 1 ? "its" : "their"} drafts weren't published.`,
  };
}
