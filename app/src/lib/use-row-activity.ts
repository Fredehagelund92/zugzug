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
const POLL_INTERVAL_MS = 5_000;

/** Polls `/api/tables/:tableId/row-activity` every 5s; returns a map keyed by
 *  rowKey carrying the latest audit entry for that row. Stale entries past 24h
 *  are pruned client-side. Returns an empty map while `tableId` is null. */
export function useRowActivity(tableId: string | null): Map<string, RowActivityEntry> {
  const [entries, setEntries] = useState<Map<string, RowActivityEntry>>(new Map());
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!tableId) {
      setEntries(new Map());
      return;
    }

    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelledRef.current) return;
      const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();
      const url = `/api/tables/${encodeURIComponent(tableId)}/row-activity?since=${encodeURIComponent(since)}`;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (cancelledRef.current) return;
        if (!res.ok) return;
        const data = (await res.json()) as { entries: RowActivityEntry[]; serverTime: string };
        if (cancelledRef.current) return;
        setEntries(() => {
          const next = new Map<string, RowActivityEntry>();
          for (const e of data.entries) next.set(e.rowKey, e);
          return next;
        });
      } catch {
        // network blip — try again on next tick
      } finally {
        if (!cancelledRef.current) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    };

    // Reset the map immediately when tableId changes so the UI doesn't show
    // stale data from the previous table while the first fetch is in flight.
    setEntries(new Map());
    void poll();

    return () => {
      cancelledRef.current = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [tableId]);

  return entries;
}
