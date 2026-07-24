// src/routes/dashboard-helpers.ts
import type { MappingRefTable } from "../data";
import type { AuditEntry } from "../store";

export type FilterKey = "all" | "attention" | "clean";
export type SortKey = "name" | "records" | "coverage" | "review" | "toPublish" | "published";
export type SortDir = "asc" | "desc";

/**
 * Human-friendly audit timestamp. The backend sends ISO strings; render those
 * as "just now" / "Nm ago" / "Nh ago" / "Nd ago", then fall back to a short
 * "Mon D" date for anything older. Non-ISO inputs (already-formatted strings)
 * are returned unchanged, so a raw ISO never leaks into the UI.
 */
export function formatTimeAgo(at: string): string {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return at;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Percentage of values already mapped (count-based, not row-weighted).
 * Note: the global "coverage" KPI in Dashboard.tsx is row-weighted via `v.current`.
 * This function counts mapping entries — use it only for per-refTable health display.
 */
export function coveragePct(refTable: MappingRefTable): number {
  const total = refTable.counts.totalDistinct;
  if (total === 0) return 100;
  return Math.round((refTable.counts.mappedCount / total) * 100);
}

/** Unpublished changes = drafts awaiting publish + records edited since the
 *  last publish (CONTEXT.md "Unpublished changes"). 0 when the refTable is level. */
export function toPublishCount(refTable: MappingRefTable): number {
  const p = refTable.publish;
  return p ? p.pendingDrafts + p.changedRecords : 0;
}

/**
 * Higher = more urgent. Drives the default "Urgency" sort.
 * Formula: newCount * 1000 + (100 - coveragePct) so tables with new values always
 * outrank clean ones, and within those, worse coverage floats higher.
 *
 * `isStaged` signals that the refTable has at least one staged draft (e.g. a remap of
 * a previously-mapped value) but no unmapped values. Such refTables would otherwise
 * score 0 and sink to the bottom of the Urgency sort, even though the dashboard
 * tags them as "needs attention". We add a mid-tier boost of 500 that's bigger
 * than the worst-coverage spread (0–100) but smaller than newCount=1's
 * contribution (1000), so staged-only refTables rank above all clean refTables and below
 * any refTable with even one new value.
 */
export function urgencyScore(refTable: MappingRefTable, isStaged: boolean = false): number {
  const newCount = refTable.counts.newCount;
  const baseUrgency = newCount * 1000 + (100 - coveragePct(refTable));
  const stagedBoost = isStaged && newCount === 0 ? 500 : 0;
  return baseUrgency + stagedBoost;
}

/**
 * Returns the most recent audit entry whose detail mentions this refTable.
 * AuditEntry has no refTableId field, so we do a case-insensitive string match
 * on both the refTable display name and the refTableId. Falls back to null.
 *
 * Assumes `auditLog` is ordered newest-first (as returned by the server).
 */
export function lastAuditForDim(
  refTableId: string,
  refTable: string,
  auditLog: AuditEntry[],
): AuditEntry | null {
  const idLower = refTableId.toLowerCase();
  const nameLower = refTable.toLowerCase();
  return (
    auditLog.find((e) => {
      const d = e.detail.toLowerCase();
      return d.includes(nameLower) || d.includes(idLower);
    }) ?? null
  );
}

export function applyFilter(refTables: MappingRefTable[], filter: FilterKey): MappingRefTable[] {
  if (filter === "all") return refTables;
  if (filter === "attention") {
    return refTables.filter((d) => d.counts.newCount > 0 || toPublishCount(d) > 0);
  }
  // "clean"
  return refTables.filter((d) => d.counts.newCount === 0 && toPublishCount(d) === 0);
}

/** Sort refTables by a column. Returns a new array — never mutates the input.
 *  Never-published rows (no publishedAt) always sort last on the published
 *  column, in both directions. */
export function applySort(
  refTables: MappingRefTable[],
  sort: SortKey,
  dir: SortDir,
): MappingRefTable[] {
  const flip = dir === "asc" ? 1 : -1;
  const copy = [...refTables];
  switch (sort) {
    case "name":
      return copy.sort((a, b) => a.refTable.localeCompare(b.refTable) * flip);
    case "records":
      return copy.sort((a, b) => (a.record.length - b.record.length) * flip);
    case "coverage":
      return copy.sort((a, b) => (coveragePct(a) - coveragePct(b)) * flip);
    case "review":
      return copy.sort((a, b) => (a.counts.newCount - b.counts.newCount) * flip);
    case "toPublish":
      return copy.sort((a, b) => (toPublishCount(a) - toPublishCount(b)) * flip);
    case "published":
      return copy.sort((a, b) => {
        const at = a.publish?.publishedAt ?? null;
        const bt = b.publish?.publishedAt ?? null;
        if (!at && !bt) return 0;
        if (!at) return 1; // nulls last, regardless of dir
        if (!bt) return -1;
        return (at < bt ? -1 : at > bt ? 1 : 0) * flip;
      });
  }
}

/** Per-refTable warehouse-sync status derived from the audit log.
 *  - "synced": latest warehouse sync event for the refTable is "Warehouse synced"
 *  - "failed": latest warehouse sync event for the refTable is "Warehouse sync failed"
 *  - "unknown": no warehouse sync events yet for the refTable (or read-only mode)
 *  The refTable is identified by the refTable's mapTable name appearing in the audit detail.
 *
 *  Assumes `audits` is ordered newest-first (as returned by the server).
 */
export function warehouseSyncStatusByDim(
  audits: AuditEntry[],
  refTables: Array<{ id: string; mapTable: string }>,
): Record<string, "synced" | "failed" | "unknown"> {
  const status: Record<string, "synced" | "failed" | "unknown"> = {};
  for (const d of refTables) status[d.id] = "unknown";

  // Audits are returned newest-first by listAudit; iterate and first match per refTable wins.
  for (const a of audits) {
    if (a.action !== "Warehouse synced" && a.action !== "Warehouse sync failed") continue;
    for (const d of refTables) {
      if (status[d.id] !== "unknown") continue;
      if (a.detail.includes(d.mapTable)) {
        status[d.id] = a.action === "Warehouse synced" ? "synced" : "failed";
      }
    }
  }
  return status;
}
