import { useLayoutEffect } from "react";

/* Overlays stack — a nav drawer can open a command palette over itself — so the
   lock is refcounted at module scope. Snapshotting per-hook would let the inner
   lock record the outer one's "hidden" and restore that on unmount, leaving the
   page permanently frozen. Only the first lock snapshots; only the last one
   restores. */
let locks = 0;
let previousBody: { overflow: string; overscrollBehavior: string } | null = null;
let previousContainer: { el: HTMLElement; overflow: string } | null = null;

/* document.body is never actually the page's scroll container in this app —
   every shell confines scrolling to an inner flex child (h-[100dvh] +
   overflow-hidden on the shell, overflow-y-auto on the content region), so
   locking body alone is a no-op: the inner region keeps scrolling right
   behind the backdrop. AppShell's is `#main`; the two admin shells
   (AdminShell, AdminLayout) don't share that id, so fall back to the class
   combination both of them (and AppShell's `#main`) use. This is two known
   shells, not a registry — extend the selector, don't build one. */
function getScrollContainer(): HTMLElement | null {
  return (
    document.getElementById("main") ??
    document.querySelector<HTMLElement>(".flex-1.overflow-y-auto")
  );
}

/**
 * Freezes background scrolling while an overlay is open, and stops iOS
 * scroll-chaining from rubber-banding the page behind it. Safe to nest.
 */
export function useScrollLock(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    if (locks === 0) {
      const { overflow, overscrollBehavior } = document.body.style;
      previousBody = { overflow, overscrollBehavior };
      document.body.style.overflow = "hidden";
      document.body.style.overscrollBehavior = "contain";

      const container = getScrollContainer();
      if (container) {
        previousContainer = { el: container, overflow: container.style.overflow };
        container.style.overflow = "hidden";
      }
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0) {
        if (previousBody) {
          document.body.style.overflow = previousBody.overflow;
          document.body.style.overscrollBehavior = previousBody.overscrollBehavior;
          previousBody = null;
        }
        if (previousContainer) {
          previousContainer.el.style.overflow = previousContainer.overflow;
          previousContainer = null;
        }
      }
    };
  }, [active]);
}
