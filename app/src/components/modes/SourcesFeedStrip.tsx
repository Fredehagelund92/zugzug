import type { MappingRefTable } from "../../data";
import { useSources, scanSources } from "../../store";
import { ago } from "../sources/utils";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { toast } from "../Toast";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";

/* SourcesFeedStrip — the one-line replacement for the old per-table "Sources"
   mode: how many warehouse columns feed this table, when they were last
   scanned, and a re-scan. Connection management proper still lives on the
   top-level Sources page. Renders nothing until a column is wired. */
export function SourcesFeedStrip({ refTable }: { refTable: MappingRefTable }) {
  const sources = useSources();
  const canScan = can(useTenant(), "table.scan");
  const wired = sources.filter((s) => s.refTableId === refTable.id);

  const rescan = useAsyncAction(async () => {
    try {
      const n = await scanSources();
      toast(`Re-scanned ${n} column${n === 1 ? "" : "s"}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't re-scan.", "error");
    }
  });

  if (wired.length === 0) return null;

  const scans = wired
    .map((s) => s.scannedAt)
    .filter((v): v is string => !!v)
    .sort();
  const lastScan = scans.at(-1) ?? null;

  return (
    <span className="flex items-center gap-2 font-mono text-[10.5px] text-ink-3">
      <span>
        {wired.length} column{wired.length === 1 ? " feeds" : "s feed"} this
      </span>
      {lastScan && <span aria-hidden>· scanned {ago(lastScan)} ago</span>}
      {canScan && (
        <button
          type="button"
          onClick={() => void rescan.run()}
          disabled={rescan.isPending}
          className="border-b border-dotted border-ink-3 text-ink-2 hover:text-ink disabled:opacity-50"
        >
          Re-scan
        </button>
      )}
    </span>
  );
}
