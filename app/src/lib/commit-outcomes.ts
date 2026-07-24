export interface CommitOutcome {
  refTableId: string;
  refTableName: string;
  committed: number;
  rowsRecovered: number;
  error: string | null;
}

export function summarizeOutcomes(outcomes: CommitOutcome[]): {
  ok: boolean;
  committed: number;
  rowsRecovered: number;
  failed: CommitOutcome[];
  message: string;
} {
  const failed = outcomes.filter((o) => o.error !== null);
  const committed = outcomes.reduce((n, o) => n + o.committed, 0);
  const rowsRecovered = outcomes.reduce((n, o) => n + o.rowsRecovered, 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (failed.length === 0) {
    return {
      ok: true,
      committed,
      rowsRecovered,
      failed,
      message: `✓ ${plural(committed, "change")} published · ${plural(rowsRecovered, "row")} recovered`,
    };
  }
  const names = failed.map((f) => `${f.refTableName} failed (${f.error})`).join("; ");
  return {
    ok: false,
    committed,
    rowsRecovered,
    failed,
    message: `Published ${plural(committed, "change")}, but ${names} — ${failed.length === 1 ? "its" : "their"} drafts weren't published.`,
  };
}
