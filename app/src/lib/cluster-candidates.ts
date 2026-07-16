export interface CandidateRecord {
  key: string;
  label: string;
}
export type Candidate =
  | { kind: "record"; key: string; label: string; closest: boolean }
  | { kind: "create"; label: string };

/** Conservative client-side fold — the browser twin of the server's
 *  normalizeKey (separate package, cannot be imported). Lowercase, strip
 *  diacritics, drop every non-alphanumeric character. */
export function foldLabel(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Build the type-ahead candidate list. With an empty query, the record whose
 * label folds to the same key as `rep` is placed first and marked `closest`,
 * followed by other records up to `limit`. With a query, records whose label or
 * key contains the query (case-insensitive) are returned. A `create` row is
 * always appended — labelled with the query when searching, else with `rep`.
 */
export function buildCandidates(
  records: CandidateRecord[],
  query: string,
  rep: string,
  limit = 4,
): Candidate[] {
  const q = query.trim();
  const out: Candidate[] = [];

  if (q) {
    const needle = q.toLowerCase();
    for (const r of records) {
      if (r.label.toLowerCase().includes(needle) || r.key.toLowerCase().includes(needle)) {
        out.push({ kind: "record", key: r.key, label: r.label, closest: false });
      }
    }
    out.push({ kind: "create", label: q });
    return out;
  }

  const repKey = foldLabel(rep);
  const closest = records.find((r) => foldLabel(r.label) === repKey);
  if (closest) {
    out.push({ kind: "record", key: closest.key, label: closest.label, closest: true });
  }
  for (const r of records) {
    if (closest && r.key === closest.key) continue;
    if (out.filter((c) => c.kind === "record").length >= limit) break;
    out.push({ kind: "record", key: r.key, label: r.label, closest: false });
  }
  out.push({ kind: "create", label: rep });
  return out;
}
