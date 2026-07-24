import { useEffect, useRef, useState, useCallback } from "react";
import { apiFetch } from "../api";

export interface ScanValueRow {
  raw: string;
  totalRows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}

export interface UseRefTableValuesPageOpts {
  refTableId: string | null;
  filter: "new" | "mapped" | "all";
  q?: string;
  enabled?: boolean;
}

export interface UseRefTableValuesPage {
  items: ScanValueRow[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  refetch: () => void;
}

/** Lazy, cursor-paginated fetch over /api/refTables/:id/scan-values. Resets
 *  when (refTableId, filter, q) changes. No caching across opts changes. */
export function useRefTableValuesPage(opts: UseRefTableValuesPageOpts): UseRefTableValuesPage {
  const { refTableId, filter, q, enabled = true } = opts;
  const [items, setItems] = useState<ScanValueRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const fetchPage = useCallback(
    async (after: string | null, reset: boolean) => {
      if (!refTableId || !enabled) return;
      const ticket = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ filter, limit: "100" });
        if (q) params.set("q", q);
        if (after) params.set("after", after);
        const r = await apiFetch(
          `/refTables/${encodeURIComponent(refTableId)}/scan-values?${params}`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as {
          items: ScanValueRow[];
          hasMore: boolean;
          nextCursor: string | null;
        };
        if (ticket !== seq.current) return;
        setItems((prev) => (reset ? body.items : [...prev, ...body.items]));
        setCursor(body.nextCursor);
        setHasMore(body.hasMore);
      } catch (e) {
        if (ticket !== seq.current) return;
        setError(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (ticket === seq.current) setLoading(false);
      }
    },
    [refTableId, filter, q, enabled],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(false);
    void fetchPage(null, true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading) return;
    void fetchPage(cursor, false);
  }, [hasMore, loading, cursor, fetchPage]);

  const refetch = useCallback(() => {
    setItems([]);
    setCursor(null);
    setHasMore(false);
    void fetchPage(null, true);
  }, [fetchPage]);

  return { items, hasMore, loading, error, loadMore, refetch };
}
