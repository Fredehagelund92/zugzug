import { useLayoutEffect, useRef, useState } from "react";
import { bindOverlayScroll } from "../../lib/overlay-scroll";

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
    // The anchor counts as inside: DateCell keeps its typed input in the cell
    // rather than the portal, and a text input scrolls *itself* once its
    // content overflows — which a narrow date column does mid-typing. Reading
    // that as "the page moved" would dismiss the editor, and this editor
    // commits on the way out, writing a half-typed date.
    return bindOverlayScroll({
      pop,
      anchor,
      place,
      onDismiss: onDismiss ? () => dismissRef.current?.() : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDismiss is read through dismissRef; depending on it would re-place on every keystroke
  }, [mounted, popRef, anchorRef, width]);
}
