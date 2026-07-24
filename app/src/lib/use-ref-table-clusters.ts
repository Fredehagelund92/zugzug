import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";

export interface ClusterMember {
  raw: string;
  rows: number;
  isMapped: boolean;
  mappedLabel: string | null;
  occurrences: { table: string; column: string; rows: number }[];
}
export interface Cluster {
  key: string;
  rep: string;
  members: ClusterMember[];
  rows: number;
  mappedCount: number;
}
export interface Coverage {
  resolvedRows: number;
  atRiskRows: number;
  pct: number;
}
export interface RefTableClusterFeed {
  clusters: Cluster[];
  coverage: Coverage;
  truncated: boolean;
}

export interface UseRefTableClustersOpts {
  refTableId: string | null;
  filter: "new" | "mapped" | "all";
  enabled?: boolean;
}
export interface UseRefTableClusters {
  clusters: Cluster[];
  coverage: Coverage;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY_COVERAGE: Coverage = { resolvedRows: 0, atRiskRows: 0, pct: 0 };

/** Load the whole cluster feed for a refTable. Mirrors useRefTableValuesPage's
 *  race-safe fetch shape, but the feed is a single (non-paginated) payload. */
export function useRefTableClusters(opts: UseRefTableClustersOpts): UseRefTableClusters {
  const { refTableId, filter, enabled = true } = opts;
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [coverage, setCoverage] = useState<Coverage>(EMPTY_COVERAGE);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const fetchFeed = useCallback(async () => {
    if (!refTableId || !enabled) return;
    const ticket = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ filter });
      const r = await apiFetch(`/tables/${encodeURIComponent(refTableId)}/clusters?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as RefTableClusterFeed;
      if (ticket !== seq.current) return;
      setClusters(body.clusters);
      setCoverage(body.coverage);
      setTruncated(body.truncated);
    } catch (e) {
      if (ticket !== seq.current) return;
      setClusters([]);
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [refTableId, filter, enabled]);

  useEffect(() => {
    setClusters([]);
    setCoverage(EMPTY_COVERAGE);
    setTruncated(false);
    void fetchFeed();
  }, [fetchFeed]);

  const refetch = useCallback(() => {
    void fetchFeed();
  }, [fetchFeed]);

  return { clusters, coverage, truncated, loading, error, refetch };
}
