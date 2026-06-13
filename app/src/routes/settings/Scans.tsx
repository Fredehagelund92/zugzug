import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SegControl } from "../../components/SegControl";
import { SkeletonRow } from "../../components/Skeleton";
import { cx } from "../../lib/cx";
import { useTenant } from "../../lib/tenant-context";
import { usePreferences, setPreferences, scanSources } from "../../store";
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
  const canEdit = can(tenant, "settings.scans.edit");
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

  const scanNow = useAsyncAction(async () => {
    try {
      const n = await scanSources();
      await loadStatus();
      toast(`Scanned ${n} value${n === 1 ? "" : "s"}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Scan failed.", "error");
    }
  });

  const handleScheduleChange = (next: string | null) => {
    void setPreferences({
      ...prefs,
      scanSchedule: next as "15m" | "hourly" | "daily" | null,
    });
  };

  const scheduleOptions = [
    { value: null, label: "Off" },
    { value: "15m", label: "15 min" },
    { value: "hourly", label: "Hourly" },
    { value: "daily", label: "Daily" },
  ];

  return (
    <SettingsSection
      title="Scans"
      hint="How often Zug Zug checks your warehouse sources for new unmapped values."
    >
      <ReadOnly enabled={!canEdit}>
        <FormField label="Schedule">
          <SegControl
            value={prefs.scanSchedule}
            options={scheduleOptions}
            onChange={handleScheduleChange}
          />
        </FormField>

        {status && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-surface-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className={cx(
                  "inline-block h-2 w-2 shrink-0 rounded-full",
                  status.unmappedCount > 0
                    ? "bg-accent shadow-[0_0_6px_var(--accent)]"
                    : "bg-ok shadow-[0_0_6px_var(--ok)]",
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
            <Button onClick={() => void scanNow.run()} loading={scanNow.isPending}>
              Scan now
            </Button>
          </div>
        )}

        {!status && !statusError && prefs.scanSchedule && (
          <SkeletonRow columns={[16, "minmax(0,1fr)", 80]} className="rounded-sm border border-line bg-surface-2 py-3" />
        )}

        {statusError && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
            <span>Couldn&rsquo;t load scan status — {statusError}</span>
            <Button variant="ghost" size="sm" onClick={() => void loadStatus()}>
              Retry
            </Button>
          </div>
        )}
      </ReadOnly>
    </SettingsSection>
  );
}
