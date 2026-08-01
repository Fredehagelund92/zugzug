import { useLayoutEffect } from "react";

/* Overlays stack — a nav drawer can open a command palette over itself — so the
   lock is refcounted at module scope. Snapshotting per-hook would let the inner
   lock record the outer one's "hidden" and restore that on unmount, leaving the
   page permanently frozen. Only the first lock snapshots; only the last one
   restores. */
let locks = 0;
let previous: { overflow: string; overscrollBehavior: string } | null = null;

/**
 * Freezes background scrolling while an overlay is open, and stops iOS
 * scroll-chaining from rubber-banding the page behind it. Safe to nest.
 */
export function useScrollLock(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    if (locks === 0) {
      const { overflow, overscrollBehavior } = document.body.style;
      previous = { overflow, overscrollBehavior };
      document.body.style.overflow = "hidden";
      document.body.style.overscrollBehavior = "contain";
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0 && previous) {
        document.body.style.overflow = previous.overflow;
        document.body.style.overscrollBehavior = previous.overscrollBehavior;
        previous = null;
      }
    };
  }, [active]);
}
