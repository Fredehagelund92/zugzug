import { buildCandidates, type CandidateRecord } from "./cluster-candidates";
import type { RecordValue } from "../data";

/** label → key lookup for a table's records (labels are unique per table). */
export function recordKeyByLabel(records: RecordValue[]): Map<string, string> {
  return new Map(records.map((r) => [r.label, r.key]));
}

/** The closest existing record label for a cluster's representative value,
 *  or null if nothing is close. Reuses the same ranking as the record picker,
 *  so the suggestion here matches what the picker pre-highlights. */
export function suggestRecordLabel(records: RecordValue[], rep: string): string | null {
  const cands = buildCandidates(
    records.map((r): CandidateRecord => ({ key: r.key, label: r.label })),
    "",
    rep,
  );
  const closest = cands.find((c) => c.kind === "record" && c.closest);
  return closest && closest.kind === "record" ? closest.label : null;
}
