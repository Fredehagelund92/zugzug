import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  debounceMs = 600,
): { status: AutosaveStatus; error: string | null } {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const initial = useRef(value);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (value === initial.current) return;
    const t = setTimeout(async () => {
      setStatus("saving");
      setError(null);
      try {
        await save(latest.current);
        initial.current = latest.current;
        setStatus("saved");
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
