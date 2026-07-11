import { useEffect } from "react";

export function formatPageTitle(title: string): string {
  return `${title.trim()} · Zug Zug`;
}

/** Sets document.title for the route (WCAG 2.4.2) and restores on unmount. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = formatPageTitle(title);
    return () => {
      document.title = prev;
    };
  }, [title]);
}
