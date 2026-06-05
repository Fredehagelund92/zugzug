// src/routes/dashboard-helpers.ts
import type { MappingDimension } from "../data";
import type { AuditEntry } from "../store";

export type FilterKey = "all" | "attention" | "clean";
export type SortKey = "urgency" | "coverage" | "name" | "rows";

/** Percentage of values already mapped (count-based, not row-weighted). */
export function coveragePct(dim: MappingDimension): number {
  if (dim.values.length === 0) return 100;
  return Math.round(
    (dim.values.filter((v) => v.status === "mapped").length / dim.values.length) * 100,
  );
}

/**
 * Higher = more urgent. Drives the default "Urgency" sort.
 * Formula: newCount * 1000 + (100 - coveragePct) so tables with new values always
 * outrank clean ones, and within those, worse coverage floats higher.
 */
export function urgencyScore(dim: MappingDimension): number {
  const newCount = dim.values.filter((v) => v.status === "new").length;
  return newCount * 1000 + (100 - coveragePct(dim));
}

/** CSS color var to use for coverage bars and percentage text. */
export function coverageColor(pct: number): string {
  if (pct >= 96) return "var(--ak-ok)";
  if (pct >= 80) return "var(--ak-warn)";
  return "var(--accent)";
}

/**
 * Returns the most recent audit entry whose detail mentions this dim.
 * AuditEntry has no dimId field, so we do a case-insensitive string match
 * on both the dimension display name and the dimId. Falls back to null.
 */
export function lastAuditForDim(
  dimId: string,
  dimension: string,
  auditLog: AuditEntry[],
): AuditEntry | null {
  const idLower = dimId.toLowerCase();
  const nameLower = dimension.toLowerCase();
  return (
    auditLog.find((e) => {
      const d = e.detail.toLowerCase();
      return d.includes(nameLower) || d.includes(idLower);
    }) ?? null
  );
}

/** Filter dims by tab selection. `stagedDimIds` is the set of dim ids that have
 *  at least one staged draft so the "Needs attention" filter surfaces them too. */
export function applyFilter(
  dims: MappingDimension[],
  filter: FilterKey,
  stagedDimIds: Set<string>,
): MappingDimension[] {
  if (filter === "all") return dims;
  if (filter === "attention") {
    return dims.filter(
      (d) => d.values.some((v) => v.status === "new") || stagedDimIds.has(d.id),
    );
  }
  // "clean"
  return dims.filter(
    (d) => !d.values.some((v) => v.status === "new") && !stagedDimIds.has(d.id),
  );
}

/** Sort dims. Returns a new array — never mutates the input. */
export function applySort(dims: MappingDimension[], sort: SortKey): MappingDimension[] {
  const copy = [...dims];
  switch (sort) {
    case "urgency":
      return copy.sort((a, b) => urgencyScore(b) - urgencyScore(a));
    case "coverage":
      return copy.sort((a, b) => coveragePct(a) - coveragePct(b));
    case "name":
      return copy.sort((a, b) => a.dimension.localeCompare(b.dimension));
    case "rows":
      return copy.sort((a, b) => b.rows - a.rows);
  }
}
