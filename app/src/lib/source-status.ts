import type { SourceInfo } from "../store";

/** Days after a scan a source is considered overdue (matches components/sources/utils.ts). */
export const STALE_DAYS = 7;

export type SourceStatus = "broken" | "new" | "stale" | "healthy";
export interface SourceStatusInfo {
  status: SourceStatus;
  unmapped: number;
  /** Scan is overdue — a secondary "counts may be stale" flag on a "new" row. */
  stale: boolean;
}

function daysAgo(iso: string | null | undefined, nowMs: number): number {
  if (!iso) return Infinity;
  return (nowMs - new Date(iso).getTime()) / 86_400_000;
}

/**
 * Collapse a source into one of four action states (grilled decision), mirroring
 * the existing six-state `standing` derivation: never-scanned or overdue-and-clean
 * → "stale" (not checked recently); vanished column → "broken"; unmapped values →
 * "new"; else "healthy". Broken is kept distinct from stale on purpose.
 */
export function classifySource(s: SourceInfo, nowMs: number = Date.now()): SourceStatusInfo {
  const stale = daysAgo(s.scannedAt, nowMs) > STALE_DAYS;
  let status: SourceStatus;
  if (!s.scanned && !s.scannedAt)
    status = "stale"; // never checked
  else if (!s.present && s.scanned)
    status = "broken"; // column vanished from the warehouse
  else if (s.unmapped > 0)
    status = "new"; // values need a record
  else if (stale)
    status = "stale"; // resolved but overdue
  else status = "healthy";
  return { status, unmapped: s.unmapped, stale };
}

const RANK: Record<SourceStatus, number> = { broken: 0, new: 1, stale: 2, healthy: 3 };

/** Sources paired with their status, ordered by urgency then by unmapped desc, rows desc. */
export function sortByUrgency(
  sources: SourceInfo[],
  nowMs: number = Date.now(),
): { source: SourceInfo; status: SourceStatusInfo }[] {
  return sources
    .map((source) => ({ source, status: classifySource(source, nowMs) }))
    .sort(
      (a, b) =>
        RANK[a.status.status] - RANK[b.status.status] ||
        b.status.unmapped - a.status.unmapped ||
        b.source.rows - a.source.rows,
    );
}

export interface SourcesSummary {
  total: number;
  broken: number;
  needsMapping: number;
  notChecked: number;
  healthy: number;
  newValuesTotal: number;
}

/** RefTable-level wiring health: counts per action state + total unmapped values. */
export function summarizeSources(
  sources: SourceInfo[],
  nowMs: number = Date.now(),
): SourcesSummary {
  const out: SourcesSummary = {
    total: sources.length,
    broken: 0,
    needsMapping: 0,
    notChecked: 0,
    healthy: 0,
    newValuesTotal: 0,
  };
  for (const s of sources) {
    const { status } = classifySource(s, nowMs);
    if (status === "broken") out.broken++;
    else if (status === "new") {
      out.needsMapping++;
      out.newValuesTotal += s.unmapped;
    } else if (status === "stale") out.notChecked++;
    else out.healthy++;
  }
  return out;
}
