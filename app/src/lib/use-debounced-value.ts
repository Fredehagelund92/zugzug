import { useEffect, useState } from "react";

/** Returns a copy of `value` that only updates after it has stopped changing
 *  for `delayMs`. Use to keep a text input responsive while throttling the
 *  expensive work it drives (a network fetch, a heavy filter) to one call per
 *  pause instead of one per keystroke. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
