// src/routes/dashboard-helpers.ts
import type { MappingDimension } from "../data";
import type { AuditEntry } from "../store";

export type FilterKey = "all" | "attention" | "clean";
export type SortKey = "urgency" | "coverage" | "name" | "rows";

/**
 * Percentage of values already mapped (count-based, not row-weighted).
 * Note: the global "coverage" KPI in Dashboard.tsx is row-weighted via `v.current`.
 * This function counts mapping entries — use it only for per-dim health display.
 */
export function coveragePct(dim: MappingDimension): number {
  const total = dim.counts.totalDistinct;
  if (total === 0) return 100;
  return Math.round((dim.counts.mappedCount / total) * 100);
}

/**
 * Higher = more urgent. Drives the default "Urgency" sort.
 * Formula: newCount * 1000 + (100 - coveragePct) so tables with new values always
 * outrank clean ones, and within those, worse coverage floats higher.
 *
 * `isStaged` signals that the dim has at least one staged draft (e.g. a remap of
 * a previously-mapped value) but no unmapped values. Such dims would otherwise
 * score 0 and sink to the bottom of the Urgency sort, even though the dashboard
 * tags them as "needs attention". We add a mid-tier boost of 500 that's bigger
 * than the worst-coverage spread (0–100) but smaller than newCount=1's
 * contribution (1000), so staged-only dims rank above all clean dims and below
 * any dim with even one new value.
 */
export function urgencyScore(dim: MappingDimension, isStaged: boolean = false): number {
  const newCount = dim.counts.newCount;
  const baseUrgency = newCount * 1000 + (100 - coveragePct(dim));
  const stagedBoost = isStaged && newCount === 0 ? 500 : 0;
  return baseUrgency + stagedBoost;
}

/**
 * Returns the most recent audit entry whose detail mentions this dim.
 * AuditEntry has no dimId field, so we do a case-insensitive string match
 * on both the dimension display name and the dimId. Falls back to null.
 *
 * Assumes `auditLog` is ordered newest-first (as returned by the server).
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
    return dims.filter((d) => d.counts.newCount > 0 || stagedDimIds.has(d.id));
  }
  // "clean"
  return dims.filter((d) => d.counts.newCount === 0 && !stagedDimIds.has(d.id));
}

/** Sort dims. Returns a new array — never mutates the input. */
export function applySort(
  dims: MappingDimension[],
  sort: SortKey,
  stagedDimIds: Set<string> = new Set(),
): MappingDimension[] {
  const copy = [...dims];
  switch (sort) {
    case "urgency":
      return copy.sort(
        (a, b) => urgencyScore(b, stagedDimIds.has(b.id)) - urgencyScore(a, stagedDimIds.has(a.id)),
      );
    case "coverage":
      return copy.sort((a, b) => coveragePct(a) - coveragePct(b));
    case "name":
      return copy.sort((a, b) => a.dimension.localeCompare(b.dimension));
    case "rows":
      return copy.sort((a, b) => b.rows - a.rows);
  }
}

/** Per-dimension warehouse-sync status derived from the audit log.
 *  - "synced": latest warehouse sync event for the dim is "Warehouse synced"
 *  - "failed": latest warehouse sync event for the dim is "Warehouse sync failed"
 *  - "unknown": no warehouse sync events yet for the dim (or read-only mode)
 *  The dim is identified by the dim's mapTable name appearing in the audit detail.
 *
 *  Assumes `audits` is ordered newest-first (as returned by the server).
 */
export function warehouseSyncStatusByDim(
  audits: AuditEntry[],
  dims: Array<{ id: string; mapTable: string }>,
): Record<string, "synced" | "failed" | "unknown"> {
  const status: Record<string, "synced" | "failed" | "unknown"> = {};
  for (const d of dims) status[d.id] = "unknown";

  // Audits are returned newest-first by listAudit; iterate and first match per dim wins.
  for (const a of audits) {
    if (a.action !== "Warehouse synced" && a.action !== "Warehouse sync failed") continue;
    for (const d of dims) {
      if (status[d.id] !== "unknown") continue;
      if (a.detail.includes(d.mapTable)) {
        status[d.id] = a.action === "Warehouse synced" ? "synced" : "failed";
      }
    }
  }
  return status;
}
