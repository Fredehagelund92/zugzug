import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { MappingDimension } from "../data";
import { useDimClusters, type Cluster } from "./use-dim-clusters";
import { buildCandidates, type Candidate, type CandidateRecord } from "./cluster-candidates";
import { pendingClusters, siblingSuggestion } from "./cluster-selection";
import { clusterMapperReducer, initMapperState, stagedCount } from "./cluster-mapper-reducer";
import { saveDraft, discardDraft } from "../store";

export interface UseClusterMapper {
  loading: boolean;
  error: string | null;
  current: Cluster | null;
  candidates: Candidate[];
  suggestion: CandidateRecord | null;
  coverage: { resolvedRows: number; atRiskRows: number; pct: number };
  truncated: boolean;
  staged: number;
  done: boolean;
  position: { index: number; total: number };
  query: string;
  setQuery: (q: string) => void;
  mapCluster: (recordKey: string, recordLabel: string) => void;
  skipCluster: () => void;
  undo: () => void;
  jumpTo: (index: number) => void;
  refetch: () => void;
}

export function useClusterMapper(dim: MappingDimension): UseClusterMapper {
  const feed = useDimClusters({ dimId: dim.id, filter: "all" });
  const pending = useMemo(() => pendingClusters(feed.clusters), [feed.clusters]);
  const records = useMemo<CandidateRecord[]>(
    () => dim.canonical.map((c) => ({ key: c.key, label: c.label })),
    [dim.canonical],
  );

  const [state, dispatch] = useReducer(clusterMapperReducer, [] as string[], initMapperState);

  // Re-init the reducer whenever the set of pending cluster keys changes.
  // Serialize the pending key set unambiguously — cluster keys can contain any
  // character (the server folds punctuation-only values to a NUL-prefixed key),
  // so a delimiter join/split is unsafe; JSON round-trips exactly.
  const keysRef = useRef<string>(JSON.stringify([]));
  const keySig = JSON.stringify(pending.map((c) => c.key));
  useEffect(() => {
    if (keySig !== keysRef.current) {
      keysRef.current = keySig;
      dispatch({ type: "init", clusterKeys: JSON.parse(keySig) as string[] });
    }
  }, [keySig]);

  const [query, setQuery] = useState("");
  const current = state.cursor < pending.length ? pending[state.cursor] : null;

  const suggestion = useMemo(
    () => (current ? siblingSuggestion(current, records) : null),
    [current, records],
  );
  const candidates = useMemo(
    () => (current ? buildCandidates(records, query, current.rep) : []),
    [current, records, query],
  );

  const mapCluster = useCallback(
    (recordKey: string, recordLabel: string) => {
      if (!current) return;
      for (const m of current.members) {
        void saveDraft(dim.id, m.raw, "mapped", recordLabel, recordKey);
      }
      dispatch({ type: "map", clusterKey: current.key, recordKey, recordLabel });
      setQuery("");
    },
    [current, dim.id],
  );

  const skipCluster = useCallback(() => {
    if (!current) return;
    for (const m of current.members) {
      void saveDraft(dim.id, m.raw, "skipped", null, null);
    }
    dispatch({ type: "skip", clusterKey: current.key });
    setQuery("");
  }, [current, dim.id]);

  const undo = useCallback(() => {
    const lastKey = state.undo[state.undo.length - 1];
    if (!lastKey) return;
    const cluster = pending.find((c) => c.key === lastKey);
    if (cluster) {
      for (const m of cluster.members) void discardDraft(dim.id, m.raw);
    }
    dispatch({ type: "undo" });
  }, [state.undo, pending, dim.id]);

  const jumpTo = useCallback((index: number) => dispatch({ type: "jumpTo", index }), []);

  return {
    loading: feed.loading,
    error: feed.error,
    current,
    candidates,
    suggestion,
    coverage: feed.coverage,
    truncated: feed.truncated,
    staged: stagedCount(state),
    done: pending.length > 0 && state.cursor >= pending.length,
    position: { index: state.cursor, total: pending.length },
    query,
    setQuery,
    mapCluster,
    skipCluster,
    undo,
    jumpTo,
    refetch: feed.refetch,
  };
}
