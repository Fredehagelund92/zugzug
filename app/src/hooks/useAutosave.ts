import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  debounceMs = 600,
  onSaved?: () => void | Promise<void>,
): { status: AutosaveStatus; error: string | null } {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const initial = useRef(value);
  const latest = useRef(value);
  const onSavedRef = useRef(onSaved);
  latest.current = value;
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (value === initial.current) return;
    const t = setTimeout(async () => {
      setStatus("saving");
      setError(null);
      try {
        await save(latest.current);
        initial.current = latest.current;
        setStatus("saved");
        // Fire the post-save callback (e.g. invalidate.X()). Errors here must
        // not roll back the "saved" pill — the save itself succeeded.
        if (onSavedRef.current) {
          try {
            await onSavedRef.current();
          } catch (cbErr) {
            console.error("useAutosave onSaved", cbErr);
          }
        }
        setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1800);
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Couldn't save — try again.");
      }
    }, debounceMs);
    return () => clearTimeout(t);
  }, [value, save, debounceMs]);

  return { status, error };
}
