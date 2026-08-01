import { useLayoutEffect } from "react";

/* Overlays stack — a nav drawer can open a command palette over itself — so the
   lock is refcounted at module scope. Snapshotting per-hook would let the inner
   lock record the outer one's "hidden" and restore that on unmount, leaving the
   page permanently frozen. Only the first lock snapshots; only the last one
   restores. */
let locks = 0;
let previousBody: { overflow: string; overscrollBehavior: string } | null = null;
let previousContainer: {
  el: HTMLElement;
  overflow: string;
  children: Array<{ el: HTMLElement; transform: string }>;
} | null = null;

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
        // "hidden" only removes the scrollbar/drag gesture — the element
        // stays scrollable via script (scrollTop/scrollBy still move it), so
        // it doesn't actually stop anything here; the "scroll" event that
        // would let a listener correct it back also isn't synchronous in a
        // real browser (confirmed live: a scrollBy took ~300ms to get
        // corrected that way, not the same tick). "clip" is the only value
        // that blocks scrolling outright and synchronously — but it also
        // forces the browser to immediately repaint the container as if
        // scrolled to 0 the instant it's applied, a real, confirmed ~400px
        // visual snap-to-top otherwise. Counter that by shifting the
        // container's children up by the scrolled amount with a transform
        // (which doesn't affect layout, only paint position) at the same
        // moment clip takes effect, so the rendered result is pixel-identical
        // to "still scrolled" — then undo both together on unlock.
        const scrollTop = container.scrollTop;
        const children = Array.from(container.children) as HTMLElement[];
        previousContainer = {
          el: container,
          overflow: container.style.overflow,
          children: children.map((el) => ({ el, transform: el.style.transform })),
        };
        container.style.overflow = "clip";
        if (scrollTop > 0) {
          for (const child of children) {
            child.style.transform = `translateY(${-scrollTop}px)`;
          }
        }
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
          for (const { el, transform } of previousContainer.children) {
            el.style.transform = transform;
          }
          previousContainer = null;
        }
      }
    };
  }, [active]);
}
