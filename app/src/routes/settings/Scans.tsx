import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { SegControl } from "../../components/SegControl";
import { SkeletonRow } from "../../components/Skeleton";
import { cx } from "../../lib/cx";
import { useTenant } from "../../lib/tenant-context";
import {
  usePreferences,
  setPreferences,
  scanSources,
  invalidate,
  subscribeInvalidate,
} from "../../store";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { toast } from "../../components/Toast";
import { relativeTime } from "./_shared";

interface ScanStatus {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
  lastAutoPublishAt?: string | null;
  lastAutoPublishDetail?: string | null;
}

export function Scans() {
  const tenant = useTenant();
  // Changing the schedule is a workspace setting (admin); running a scan is an
  // editor capability — two gates, because the server has two.
  const canEditSchedule = can(tenant, "settings.scans.edit");
  const canScan = can(tenant, "table.scan");
  const prefs = usePreferences();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const r = await apiFetch("/sources/scan-status");
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setStatus((await r.json()) as ScanStatus);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const unsub = subscribeInvalidate("scans", (slug) => {
      if (slug && slug !== tenant.slug) return;
      void loadStatus();
    });
    return unsub;
  }, [loadStatus, tenant.slug]);

  const scanNow = useAsyncAction(async () => {
    try {
      // scanSources() returns the number of source COLUMNS it scanned, not values.
      const n = await scanSources();
      await loadStatus();
      toast(`Scanned ${n} source${n === 1 ? "" : "s"}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't scan.", "error");
    }
  });

  const handleScheduleChange = (next: string | null) => {
    setPreferences({
      ...prefs,
      scanSchedule: next as "hourly" | "daily" | null,
    })
      .then(() => invalidate.scans(tenant.slug))
      .catch((e) => {
        toast(
          e instanceof Error
            ? `Couldn't update schedule: ${e.message}`
            : "Couldn't update schedule.",
          "error",
        );
      });
  };

  const scheduleOptions = [
    { value: null, label: "Off" },
    { value: "hourly", label: "Hourly" },
    { value: "daily", label: "Daily" },
  ];

  return (
    <SettingsSection
      title="Scans"
      hint="How often Zug Zug checks your warehouse sources for new unmapped values."
      bare
    >
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <ReadOnly enabled={!canEditSchedule}>
          {/* Schedule — label left, control right */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-4 py-3.5">
            <div>
              <div className="text-[13px] font-semibold text-ink">Schedule</div>
              <div className="mt-0.5 text-[11.5px] text-ink-3">
                Automatic scans run in the background.
              </div>
            </div>
            <SegControl
              value={prefs.scanSchedule}
              options={scheduleOptions}
              onChange={handleScheduleChange}
            />
          </div>
        </ReadOnly>

        {/* Live scan status */}
        {status && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <span
                className={cx(
                  "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                  status.unmappedCount > 0
                    ? "bg-accent shadow-[0_0_0_3px_var(--accent-soft)]"
                    : "bg-ok shadow-[0_0_0_3px_var(--ak-ok-soft)]",
                )}
              />
              <span className="font-mono text-[11.5px] text-ink-2">
                last scan {relativeTime(status.lastScanAt)}
                {" · "}
                {status.sourceCount} {status.sourceCount === 1 ? "source" : "sources"}
                {status.unmappedCount > 0 && (
                  <span className="text-accent"> · {status.unmappedCount} unmapped</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {scanNow.isPending && (
                <span className="font-mono text-[10.5px] text-ink-3" aria-live="polite">
                  scanning…
                </span>
              )}
              {canScan && (
                <Button size="sm" onClick={() => void scanNow.run()} loading={scanNow.isPending}>
                  Scan now
                </Button>
              )}
            </div>
          </div>
        )}

        {!status && !statusError && prefs.scanSchedule && (
          <SkeletonRow columns={[16, "minmax(0,1fr)", 80]} className="px-4 py-3.5" />
        )}

        {statusError && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-danger/30 bg-danger-soft px-4 py-3 font-mono text-[11.5px] text-danger">
            <span>Couldn&rsquo;t load scan status — {statusError}</span>
            <Button variant="ghost" size="sm" onClick={() => void loadStatus()}>
              Retry
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
