import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import type { AuditEntry } from "../store";

interface HistoryPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}

export interface RecordHistoryState {
  entries: AuditEntry[];
  /** First page in flight (drawer just opened). */
  loading: boolean;
  /** A "Load older" page in flight. */
  loadingMore: boolean;
  error: boolean;
  hasMore: boolean;
  loadMore: () => void;
  /** Re-fetch the first page (used by the error-state retry). */
  reload: () => void;
}

const PAGE_SIZE = 50;

/** Fetches one record's change history from
 *  `/api/tables/:tableId/records/:rowKey/history`, newest first, with keyset
 *  pagination. Fetches only while `enabled` (the drawer is open); resets and
 *  refetches whenever the target record changes. */
export function useRecordHistory(
  tableId: string | null,
  rowKey: string | null,
  enabled: boolean,
): RecordHistoryState {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Guards against a stale in-flight response landing after the record changed.
  const reqIdRef = useRef(0);

  const fetchPage = useCallback(
    async (cursor: string | null, reqId: number) => {
      if (!tableId || !rowKey) return;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set("before", cursor);
      // Tenant-aware: apiFetch rewrites to /api/t/<slug>/tables/... .
      const path = `/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(rowKey)}/history?${params}`;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(false);
      try {
        const res = await apiFetch(path);
        if (reqId !== reqIdRef.current) return; // superseded by a newer record
        if (!res.ok) {
          setError(true);
          return;
        }
        const page = (await res.json()) as HistoryPage;
        if (reqId !== reqIdRef.current) return;
        setEntries((prev) => (cursor ? [...prev, ...page.entries] : page.entries));
        cursorRef.current = page.nextCursor;
        setHasMore(page.nextCursor != null);
      } catch {
        if (reqId === reqIdRef.current) setError(true);
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [tableId, rowKey],
  );

  // (Re)load the first page whenever the drawer opens on a new record.
  useEffect(() => {
    if (!enabled || !tableId || !rowKey) return;
    const reqId = ++reqIdRef.current;
    setEntries([]);
    cursorRef.current = null;
    setHasMore(false);
    void fetchPage(null, reqId);
  }, [enabled, tableId, rowKey, fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !cursorRef.current) return;
    void fetchPage(cursorRef.current, reqIdRef.current);
  }, [loading, loadingMore, fetchPage]);

  const reload = useCallback(() => {
    if (!tableId || !rowKey) return;
    const reqId = ++reqIdRef.current;
    setEntries([]);
    cursorRef.current = null;
    setHasMore(false);
    void fetchPage(null, reqId);
  }, [tableId, rowKey, fetchPage]);

  return { entries, loading, loadingMore, error, hasMore, loadMore, reload };
}
