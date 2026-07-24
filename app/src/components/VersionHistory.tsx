import { useEffect, useState } from "react";
import { fetchVersions, rollbackDim, type VersionInfo } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { useTenant } from "../lib/tenant-context";
import { can } from "../lib/permissions";

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface VersionHistoryProps {
  refTableId: string;
  onClose: () => void;
  onRollbackSuccess: () => void;
  flash: (msg: string, tone?: "info" | "danger") => void;
}

export function VersionHistory({
  refTableId,
  onClose,
  onRollbackSuccess,
  flash,
}: VersionHistoryProps) {
  const tenant = useTenant();
  const isAdmin = can(tenant, "table.rollback");

  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<VersionInfo | null>(null);
  const [rolling, setRolling] = useState(false);

  const load = () => {
    fetchVersions(refTableId)
      .then(setVersions)
      .catch(() => setVersions([]));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refTableId]);

  const latestVersion = versions && versions.length > 0 ? versions[0]!.version : null;

  const handleRollback = async () => {
    if (!rollbackTarget) return;
    setRolling(true);
    try {
      await rollbackDim(refTableId, rollbackTarget.version);
      setRollbackTarget(null);
      load();
      onRollbackSuccess();
    } catch (err) {
      flash(`Rollback failed — ${err instanceof Error ? err.message : "unknown error"}`, "danger");
    } finally {
      setRolling(false);
    }
  };

  return (
    <>
      <div className="border-b border-line bg-surface-2 px-4 py-3 text-[13px]">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Version history
          </div>
          <button
            className="text-[12px] text-ink-3 hover:text-ink"
            onClick={onClose}
            aria-label="Close version history"
          >
            ✕
          </button>
        </div>

        {versions === null ? (
          <div className="py-2 text-[12px] text-ink-3">Loading…</div>
        ) : versions.length === 0 ? (
          <div className="py-2 text-[12px] text-ink-3">No versions published yet.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {versions.map((v, i) => {
              const isNewest = i === 0;
              const kindLabel =
                v.kind === "rollback" && v.restoresVersion != null
                  ? `restores v${v.restoresVersion}`
                  : "publish";
              return (
                <div
                  key={v.version}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-surface px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] text-ink-2">
                    <span className="font-semibold text-ink">v{v.version}</span>
                    <span className="text-ink-3">·</span>
                    <span>{kindLabel}</span>
                    <span className="text-ink-3">·</span>
                    <span>{v.publishedByName}</span>
                    <span className="text-ink-3">·</span>
                    <span title={new Date(v.at).toLocaleString()}>{relativeTime(v.at)}</span>
                    <span className="text-ink-3">·</span>
                    <span>
                      {v.counts.records} record{v.counts.records === 1 ? "" : "s"} /{" "}
                      {v.counts.mappings} mapping{v.counts.mappings === 1 ? "" : "s"}
                    </span>
                  </div>
                  {isAdmin && !isNewest && (
                    <button
                      className="shrink-0 rounded-sm border border-line-2 px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-accent hover:text-accent disabled:opacity-40"
                      disabled={rolling}
                      onClick={() => setRollbackTarget(v)}
                      data-testid="rollback-button"
                    >
                      Roll back to v{v.version}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3 text-[11.5px] text-ink-3">
          Versions published before version history existed can&apos;t be rolled back.
        </div>
      </div>

      {rollbackTarget && (
        <ConfirmDialog
          open={true}
          title={`Roll back to v${rollbackTarget.version}?`}
          body={`Publishes a new version v${latestVersion != null ? latestVersion + 1 : "?"} with v${rollbackTarget.version}'s content — ${rollbackTarget.counts.records} records, ${rollbackTarget.counts.mappings} mappings. Your drafts are kept. Downstream systems receive a normal publish event marked as a rollback.`}
          confirmLabel={`Roll back to v${rollbackTarget.version}`}
          confirmPhrase={`v${rollbackTarget.version}`}
          danger
          loading={rolling}
          onConfirm={handleRollback}
          onCancel={() => setRollbackTarget(null)}
        />
      )}
    </>
  );
}
