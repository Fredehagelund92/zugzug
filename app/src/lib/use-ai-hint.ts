import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";

export interface AiHint {
  suggestion: string | null;
  confidence: number;
  reasoning: string;
  cached?: boolean;
}

interface State {
  hint: AiHint | null;
  loading: boolean;
  error: boolean;
}

// Module-level session cache — survives remounts, makes re-focuses instant.
const sessionCache = new Map<string, AiHint>();

function cacheKey(refTableId: string, raw: string): string {
  return `${refTableId}::${raw}`;
}

export function useAiHint(refTableId: string, raw: string, enabled: boolean): State {
  const [state, setState] = useState<State>(() => {
    const cached = enabled ? sessionCache.get(cacheKey(refTableId, raw)) : undefined;
    return { hint: cached ?? null, loading: false, error: false };
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !refTableId || !raw) return;

    const key = cacheKey(refTableId, raw);
    const cached = sessionCache.get(key);
    if (cached) {
      setState({ hint: cached, loading: false, error: false });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: false }));

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const qs = new URLSearchParams({ refTableId, raw });
      apiFetch(`/triage/ai-hint?${qs.toString()}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.json() as Promise<AiHint>;
        })
        .then((hint) => {
          sessionCache.set(key, hint);
          setState({ hint, loading: false, error: false });
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setState({ hint: null, loading: false, error: true });
        });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [refTableId, raw, enabled]);

  return state;
}
