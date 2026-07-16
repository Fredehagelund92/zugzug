import { useCallback, useEffect, useState } from "react";
import type { Candidate, CandidateRecord } from "./cluster-candidates";

export interface CandidatePickerOpts {
  candidates: Candidate[];
  suggestion: CandidateRecord | null;
  onMap: (recordKey: string, recordLabel: string) => void;
  onUndo: () => void;
  onQueryReset: () => void;
}
export interface UseCandidatePicker {
  active: number;
  setActive: (i: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  commit: (candidate: Candidate) => void;
}

/** Client twin of the store's slug — resolves a "create new record" label to a key. */
const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function defaultActive(candidates: Candidate[], suggestion: CandidateRecord | null): number {
  if (suggestion) {
    const i = candidates.findIndex((c) => c.kind === "record" && c.key === suggestion.key);
    if (i >= 0) return i;
  }
  return 0;
}

export function useCandidatePicker(opts: CandidatePickerOpts): UseCandidatePicker {
  const { candidates, suggestion, onMap, onUndo, onQueryReset } = opts;
  const [active, setActive] = useState(() => defaultActive(candidates, suggestion));

  // Re-seed the highlight whenever the candidate list or suggestion changes.
  useEffect(() => {
    setActive(defaultActive(candidates, suggestion));
  }, [candidates, suggestion]);

  const commit = useCallback(
    (candidate: Candidate) => {
      if (candidate.kind === "create") onMap(slugKey(candidate.label), candidate.label);
      else onMap(candidate.key, candidate.label);
    },
    [onMap],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const n = candidates.length;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        onUndo();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (n === 0 ? 0 : (a + 1) % n));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (n === 0 ? 0 : (a - 1 + n) % n));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cand = candidates[active];
        if (cand) commit(cand);
      } else if (e.key === "Tab" && suggestion) {
        e.preventDefault();
        onMap(suggestion.key, suggestion.label);
      } else if (e.key === "Escape") {
        onQueryReset();
      }
    },
    [candidates, active, suggestion, commit, onMap, onUndo, onQueryReset],
  );

  return { active, setActive, onKeyDown, commit };
}
