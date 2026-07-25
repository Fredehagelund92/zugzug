import { useLayoutEffect, useState } from "react";

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
): void {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => setMounted(true), []);

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
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [mounted, popRef, anchorRef, width]);
}
