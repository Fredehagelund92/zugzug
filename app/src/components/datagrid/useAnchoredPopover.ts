import { useLayoutEffect, useRef, useState } from "react";

/* Positions a fixed-position portal popover under (or above) its anchor cell,
   re-reading on scroll/resize.

   Cell editors are rendered *inside* the very cell they anchor to, so on the
   commit that opens the editor the anchor cell's ref is attached only after
   this child's layout effect has already run — anchorRef.current is still null
   and the popover would be stuck at its initial top:0/left:0 (top-left corner).
   Forcing one post-mount pass (mounted flag) re-runs the placement once the
   parent ref is attached, before paint, so there is no visible flash. */
export function useAnchoredPopover(
  popRef: React.RefObject<HTMLElement | null>,
  anchorRef: React.RefObject<HTMLElement | null>,
  width: number,
  /* Called when the page scrolls underneath the editor. Provide it and the
     editor closes instead of chasing its cell — a picker dragged across the
     screen mid-scroll is worse than one that closes. Each caller passes the
     same thing its outside-click handler does, so scrolling away and clicking
     away treat an in-progress edit identically. Scrolling a list *inside* the
     popover never dismisses it. */
  onDismiss?: () => void,
): void {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => setMounted(true), []);
  // Held in a ref: these editors re-render on every keystroke, and the
  // dismisser closes over state, so depending on it directly would re-place
  // the popover on each character typed.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    const pop = popRef.current;
    const anchor = anchorRef.current;
    if (!pop || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const popH = pop.offsetHeight;
      let left = a.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      let top = a.bottom + 2;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - 2 - popH);
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    };
    place();
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      const inside = target != null && target !== document && pop.contains(target);
      if (dismissRef.current && !inside) dismissRef.current();
      else place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [mounted, popRef, anchorRef, width]);
}
