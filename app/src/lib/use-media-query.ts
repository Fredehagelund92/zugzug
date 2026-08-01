import { useEffect, useState } from "react";

/** Subscribes to a CSS media query. SSR-safe: falls back to false with no window. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** The app's one mobile breakpoint — matches Tailwind's `md`. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
