import { useCallback, useRef, useState } from "react";

export interface AsyncAction<TArgs extends unknown[]> {
  /** Invoke the wrapped function. Re-entry while `isPending` is silently dropped. */
  run: (...args: TArgs) => Promise<void>;
  isPending: boolean;
  error: Error | null;
  /** Clear `error` and `isPending` so the action can be retried cleanly. */
  reset: () => void;
}

/** Wraps an async function with pending-state, error capture, and re-entry guard.
 *  Use as the canonical pattern for any user-triggered async action whose UI must
 *  reflect in-flight state (spinner) or surface failures (flash / inline error). */
export function useAsyncAction<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<unknown>,
): AsyncAction<TArgs> {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pendingRef = useRef(false);

  const run = useCallback(
    async (...args: TArgs): Promise<void> => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        await fn(...args);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [fn],
  );

  const reset = useCallback(() => {
    setError(null);
    pendingRef.current = false;
    setPending(false);
  }, []);

  return { run, isPending, error, reset };
}
