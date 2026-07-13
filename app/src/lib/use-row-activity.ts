import { useEffect, useRef, useState } from "react";

export type AuditOp = "rename" | "create" | "archive" | "field-write" | "merge" | "commit";

export interface RowActivityEntry {
  rowKey: string;
  userId: string;
  displayName: string;
  op: AuditOp;
  at: string; // ISO timestamp
}

const TWENTY_FOUR_HOURS_MS = 86_400_000;
const REFETCH_DEBOUNCE_MS = 250; // coalesce paste-fill / burst pushes into one refetch
const SAFETY_NET_MS = 60_000; // long poll catches missed pushes / reconnect gaps

/** Fetches `/api/tables/:tableId/row-activity` and returns a map keyed by rowKey
 *  carrying the latest audit entry for that row. Stale entries past 24h are
 *  pruned server-side by the `since` window.
 *
 *  Push-driven: one initial fetch, then a debounced refetch whenever the caller
 *  bumps `refetchNonce` (from a `row_touched` presence hint), plus a 60s
 *  safety-net poll. Returns an empty map while `tableId` is null. */
export function useRowActivity(
  tableId: string | null,
  opts?: { refetchNonce?: number },
): Map<string, RowActivityEntry> {
  const [entries, setEntries] = useState<Map<string, RowActivityEntry>>(new Map());
  const cancelledRef = useRef(false);
  const refetchNonce = opts?.refetchNonce ?? 0;

  // Single fetch implementation, re-created per tableId and held in a ref so
  // both the mount/safety-net effect and the debounced-push effect share it.
  const fetchActivityRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    fetchActivityRef.current = async () => {
      if (!tableId || cancelledRef.current) return;
      const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();
      const url = `/api/tables/${encodeURIComponent(tableId)}/row-activity?since=${encodeURIComponent(since)}`;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (cancelledRef.current || !res.ok) return;
        const data = (await res.json()) as { entries: RowActivityEntry[]; serverTime: string };
        if (cancelledRef.current) return;
        setEntries(() => {
          const next = new Map<string, RowActivityEntry>();
          for (const e of data.entries) next.set(e.rowKey, e);
          return next;
        });
      } catch {
        // network blip — the 60s safety net or the next push will retry
      }
    };
  }, [tableId]);

  // Initial fetch + 60s safety net, reset whenever tableId changes.
  useEffect(() => {
    if (!tableId) {
      setEntries(new Map());
      return;
    }
    cancelledRef.current = false;

    // Reset the map immediately when tableId changes so the UI doesn't show
    // stale data from the previous table while the first fetch is in flight.
    setEntries(new Map());
    void fetchActivityRef.current();

    const safetyNet = setInterval(() => void fetchActivityRef.current(), SAFETY_NET_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(safetyNet);
    };
  }, [tableId]);

  // Debounced push refetch: a nonce bump schedules one refetch ~250ms later,
  // coalescing bursts. Skips the initial mount (nonce 0 == no push yet).
  useEffect(() => {
    if (!tableId || refetchNonce === 0) return;
    const timer = setTimeout(() => void fetchActivityRef.current(), REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tableId, refetchNonce]);

  return entries;
}
