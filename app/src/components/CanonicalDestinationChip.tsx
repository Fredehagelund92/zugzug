import { useWorkspaceInfo, useDimensions, useAudit } from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { warehouseSyncStatusByDim } from "../routes/dashboard-helpers";
import { cx } from "../lib/cx";

/** Topbar chip showing the workspace's canonical destination + sync rollup.
 *  Engineer-mode-gated detail in the tooltip. */
export function CanonicalDestinationChip() {
  const wsInfo = useWorkspaceInfo();
  const dims = useDimensions();
  const audit = useAudit();
  const { engineer } = useEngineerMode();

  // Defensive: `useWorkspaceInfo` may return null (loading) or a partial shape
  // if the /api/workspace/info endpoint returned an error/404 (e.g. stale server).
  if (!wsInfo || typeof wsInfo.adapter !== "string" || wsInfo.adapter.length === 0) {
    return null;
  }

  const adapterLabel = wsInfo.adapter[0].toUpperCase() + wsInfo.adapter.slice(1);
  const modeLabel = wsInfo.writable ? `🟢 ${adapterLabel} — writable` : "📦 Local + export";

  // Sync rollup is only meaningful in writable mode.
  let failedCount = 0;
  if (wsInfo.writable && dims.length > 0) {
    const status = warehouseSyncStatusByDim(audit, dims);
    failedCount = Object.values(status).filter((s) => s === "failed").length;
  }

  // Tooltip: engineer mode shows full schema path; otherwise the friendly summary.
  const friendlyTip = wsInfo.writable
    ? `Commits MERGE into ${wsInfo.warehouseDb ?? "warehouse"}`
    : "Postgres canonical; download Parquet on demand";
  const tooltip =
    engineer && wsInfo.warehouseDb
      ? `${friendlyTip}\nAdapter: ${wsInfo.adapter} · DB: ${wsInfo.warehouseDb} · Mode: ${wsInfo.canonicalMode}`
      : friendlyTip;

  return (
    <div
      className={cx(
        "hidden md:flex items-center gap-1.5 rounded-sm border border-line-2 bg-surface px-2.5 h-8 font-mono text-[11px] text-ink-2",
      )}
      title={tooltip}
      aria-label={`Canonical destination: ${modeLabel}${failedCount > 0 ? `, ${failedCount} ${failedCount === 1 ? "dimension needs" : "dimensions need"} resync` : ""}`}
    >
      <span>{modeLabel}</span>
      {failedCount > 0 && (
        <>
          <span className="text-line-2">·</span>
          <span className="text-warn">
            {failedCount} {failedCount === 1 ? "needs" : "need"} resync
          </span>
        </>
      )}
    </div>
  );
}
