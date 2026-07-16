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
export interface DimClusterFeed {
  clusters: Cluster[];
  coverage: Coverage;
  truncated: boolean;
}

export interface UseDimClustersOpts {
  dimId: string | null;
  filter: "new" | "mapped" | "all";
  enabled?: boolean;
}
export interface UseDimClusters {
  clusters: Cluster[];
  coverage: Coverage;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY_COVERAGE: Coverage = { resolvedRows: 0, atRiskRows: 0, pct: 100 };

/** Load the whole cluster feed for a dimension. Mirrors useDimValuesPage's
 *  race-safe fetch shape, but the feed is a single (non-paginated) payload. */
export function useDimClusters(opts: UseDimClustersOpts): UseDimClusters {
  const { dimId, filter, enabled = true } = opts;
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [coverage, setCoverage] = useState<Coverage>(EMPTY_COVERAGE);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const fetchFeed = useCallback(async () => {
    if (!dimId || !enabled) return;
    const ticket = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ filter });
      const r = await apiFetch(`/dimensions/${encodeURIComponent(dimId)}/clusters?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as DimClusterFeed;
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
  }, [dimId, filter, enabled]);

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
