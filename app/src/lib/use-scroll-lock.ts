import { useLayoutEffect } from "react";

/**
 * Freezes background scrolling while an overlay is open, and stops iOS
 * scroll-chaining from rubber-banding the page behind it.
 */
export function useScrollLock(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const { overflow, overscrollBehavior } = document.body.style;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "contain";
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.overscrollBehavior = overscrollBehavior;
    };
  }, [active]);
}
