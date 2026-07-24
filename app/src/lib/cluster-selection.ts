import type { Cluster } from "./use-ref-table-clusters";
import { foldLabel, type CandidateRecord } from "./cluster-candidates";

/** The mapper's work queue: clusters with at least one still-unmapped member.
 *  Fully-mapped clusters are done and excluded. Input order (worst-first) is
 *  preserved. */
export function pendingClusters(clusters: Cluster[]): Cluster[] {
  return clusters.filter((c) => c.mappedCount < c.members.length);
}

/**
 * If a cluster already has a mapped member, return the record it was mapped to —
 * a prior human decision on the same family, the strongest pre-highlight. When
 * several members are mapped, the highest-rows one wins — it is the highest-impact
 * decision. Matches the record by exact label, then by conservative fold. Returns
 * null if nothing is mapped or the label matches no known record.
 */
export function siblingSuggestion(
  cluster: Cluster,
  records: CandidateRecord[],
): CandidateRecord | null {
  let mapped: Cluster["members"][number] | null = null;
  for (const m of cluster.members) {
    if (m.isMapped && m.mappedLabel && (!mapped || m.rows > mapped.rows)) mapped = m;
  }
  if (!mapped || !mapped.mappedLabel) return null;
  const label = mapped.mappedLabel;
  const exact = records.find((r) => r.label === label);
  if (exact) return exact;
  const key = foldLabel(label);
  return records.find((r) => foldLabel(r.label) === key) ?? null;
}
