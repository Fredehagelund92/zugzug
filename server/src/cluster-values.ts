/* cluster-values.ts — deterministic, conservative clustering of scanned source
   values. Values that fold to the SAME normalized key are one cluster; anything
   less certain stays its own cluster (bias to under-cluster). No fuzzy matching
   or aliasing here — that is an opt-in layer built above this module. Pure: no
   I/O, no DB, no env, no React. */

import type { ScanValueRow } from "./repo-dim-scan.ts";

/**
 * Fold a raw value to its conservative cluster key: NFKD-normalize, strip
 * diacritics, lowercase, then drop every non-alphanumeric character. "U.S.A."
 * and "usa" both fold to "usa"; "US" folds to "us" and is kept separate on
 * purpose. A value that folds to the empty string (punctuation-only) gets a
 * unique per-raw key prefixed with NUL so such values never merge together.
 */
export function normalizeKey(raw: string): string {
  const folded = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return folded === "" ? `\u0000${raw}` : folded;
}

/**
 * Group raw values for SEEDING a dimension the same way review clusters them:
 * members folding to one `normalizeKey` become one cluster (case, punctuation
 * and diacritics all fold — "U.S.A." and "usa" merge; "US" stays separate).
 * The first-seen raw is the representative; the caller derives a readable key
 * from it. Preserves first-seen order. Pure — no slug/DB dependency here.
 */
export function clusterForSeed(values: string[]): Array<{ rep: string; raws: string[] }> {
  const byKey = new Map<string, { rep: string; raws: string[] }>();
  for (const v of values) {
    const k = normalizeKey(v);
    const c = byKey.get(k);
    if (c) c.raws.push(v);
    else byKey.set(k, { rep: v, raws: [v] });
  }
  return [...byKey.values()];
}

/** A raw value plus its downstream row weight. */
export interface ClusterInput {
  raw: string;
  rows: number;
}

/** A group of look-alike values sharing one normalized key. */
export interface ValueCluster {
  /** Deterministic fold key shared by all members. */
  key: string;
  /** Representative raw value: the member with the most rows (ties → raw asc). */
  rep: string;
  /** Members, sorted rows desc then raw asc. */
  members: ClusterInput[];
  /** Sum of member rows — the cluster's downstream impact. */
  rows: number;
}

// Shared deterministic comparators (also used by clusterScanRows).
function cmpByRowsThenRaw(
  a: { rows: number; raw: string },
  b: { rows: number; raw: string },
): number {
  return b.rows - a.rows || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0);
}
function cmpByRowsThenRep(
  a: { rows: number; rep: string },
  b: { rows: number; rep: string },
): number {
  return b.rows - a.rows || (a.rep < b.rep ? -1 : a.rep > b.rep ? 1 : 0);
}

/**
 * Group inputs into deterministic clusters. Values folding to the same
 * `normalizeKey` merge; everything else stays separate. Output order is stable:
 * clusters by rows desc then rep asc, members by rows desc then raw asc.
 */
export function clusterValues(values: ClusterInput[]): ValueCluster[] {
  const byKey = new Map<string, ClusterInput[]>();
  for (const v of values) {
    const key = normalizeKey(v.raw);
    const arr = byKey.get(key);
    if (arr) arr.push(v);
    else byKey.set(key, [v]);
  }

  const clusters: ValueCluster[] = [];
  for (const [key, members] of byKey) {
    members.sort(cmpByRowsThenRaw);
    const rows = members.reduce((sum, m) => sum + m.rows, 0);
    clusters.push({ key, rep: members[0].raw, members, rows });
  }
  clusters.sort(cmpByRowsThenRep);
  return clusters;
}

/** A scan-row member of a cluster — richer than ClusterInput, keeps occurrences. */
export interface ScanValueMember {
  raw: string;
  rows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}

/** A cluster of scan rows, plus how many members are already mapped. */
export interface ScanValueCluster {
  key: string;
  rep: string;
  members: ScanValueMember[];
  rows: number;
  mappedCount: number;
}

/**
 * Cluster real `ScanValueRow`s the way `clusterValues` clusters plain inputs,
 * but preserve each member's occurrences and mapped state and report how many
 * members are already mapped. Weight is `totalRows`.
 */
export function clusterScanRows(rows: ScanValueRow[]): ScanValueCluster[] {
  const byKey = new Map<string, ScanValueMember[]>();
  for (const r of rows) {
    const key = normalizeKey(r.raw);
    const member: ScanValueMember = {
      raw: r.raw,
      rows: r.totalRows,
      isMapped: r.isMapped,
      mappedLabel: r.mappedLabel,
      occurrences: r.occurrences,
    };
    const arr = byKey.get(key);
    if (arr) arr.push(member);
    else byKey.set(key, [member]);
  }

  const clusters: ScanValueCluster[] = [];
  for (const [key, members] of byKey) {
    members.sort(cmpByRowsThenRaw);
    const rows2 = members.reduce((sum, m) => sum + m.rows, 0);
    const mappedCount = members.reduce((n, m) => n + (m.isMapped ? 1 : 0), 0);
    clusters.push({ key, rep: members[0].raw, members, rows: rows2, mappedCount });
  }
  clusters.sort(cmpByRowsThenRep);
  return clusters;
}
