import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { bindOverlayScroll } from "../lib/overlay-scroll";

/** Space between the anchor and the popover. */
const GAP = 6;
/** Smallest allowed distance from any viewport edge. */
const MARGIN = 8;

export interface AnchorBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Placement {
  top: number;
  left: number;
}

/**
 * Where to put a popover so it stays on screen: below the anchor by default,
 * flipped above when it would overflow the bottom, and clamped to both edges.
 *
 * Pure so the geometry can be tested without a layout engine — jsdom reports
 * every rect as 0×0, so this is the only part of positioning a unit test can
 * actually verify.
 */
export function placeAnchored(
  anchor: AnchorBox,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "left" | "right" = "left",
): Placement {
  let left = align === "right" ? anchor.right - popover.width : anchor.left;
  if (left + popover.width > viewport.width - MARGIN) {
    left = viewport.width - popover.width - MARGIN;
  }
  if (left < MARGIN) left = MARGIN;

  let top = anchor.bottom + GAP;
  if (top + popover.height > viewport.height - MARGIN) {
    const above = anchor.top - GAP - popover.height;
    // Prefer flipping above; if it doesn't fit there either (popover taller
    // than the anchor's headroom), sit against the bottom edge rather than
    // hanging off it.
    top = above >= MARGIN ? above : Math.max(MARGIN, viewport.height - popover.height - MARGIN);
  }
  return { top, left };
}

/** A live element to measure, or a rect snapshot taken when the popover opened. */
export type Anchor = React.RefObject<HTMLElement | null> | AnchorBox | null;

function readAnchor(anchor: Anchor): AnchorBox | null {
  if (!anchor) return null;
  if ("current" in anchor) {
    const el = anchor.current;
    return el ? el.getBoundingClientRect() : null;
  }
  // A zero rect means the caller failed to resolve its trigger. Treat it as
  // "no anchor" rather than pinning the popover to the top-left corner (#203).
  if (anchor.top === 0 && anchor.bottom === 0 && anchor.left === 0 && anchor.right === 0) {
    return null;
  }
  return anchor;
}

interface Props {
  /** Trigger to anchor to. A ref re-measures on scroll/resize; a rect is a snapshot. */
  anchor: Anchor;
  /** Align the popover's left edge to the anchor's left (default) or its right edge to the anchor's right. */
  align?: "left" | "right";
  /** Called when the page scrolls underneath the popover. Provide this and the
   *  popover closes instead of chasing its anchor — dragging a menu around the
   *  screen while the user scrolls is worse than dismissing it. Scrolling a list
   *  *inside* the popover never dismisses it. */
  onDismiss?: () => void;
  className?: string;
  children: ReactNode;
  /** Receives the portaled element. Outside-click handlers must consult this
   *  as well as the trigger — once portaled, the panel is no longer a DOM
   *  descendant of the wrapper those handlers usually test. */
  popoverRef?: React.MutableRefObject<HTMLDivElement | null>;
  role?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

/**
 * Portals its children to document.body and positions them against `anchor`,
 * clamped and flipped to stay within the viewport.
 *
 * Portaling is what keeps a menu from being clipped by an ancestor's
 * `overflow: hidden` (#195); the clamping is what keeps it from running off
 * the edge of the screen.
 *
 * When the anchor can't be resolved the popover is centered rather than pinned
 * to 0,0 — a misplaced-but-visible panel beats one stuck in the corner.
 */
export function AnchoredPopover({
  anchor,
  align = "left",
  className,
  children,
  popoverRef,
  onDismiss,
  ...rest
}: Props): React.ReactPortal {
  const ref = useRef<HTMLDivElement | null>(null);
  // Held in a ref so an inline `onDismiss={() => setOpen(false)}` doesn't
  // re-subscribe the scroll listener (and re-place) on every parent render.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const setRef = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (popoverRef) popoverRef.current = el;
  };
  // Cell editors mount inside the element they anchor to, so on the first
  // layout pass the anchor ref may not be attached yet. One forced post-mount
  // pass re-places before paint, so there is no visible jump.
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    const pop = ref.current;
    if (!pop) return;
    const place = () => {
      const box = readAnchor(anchor);
      const size = { width: pop.offsetWidth, height: pop.offsetHeight };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (!box) {
        pop.style.top = `${Math.max(MARGIN, (viewport.height - size.height) / 2)}px`;
        pop.style.left = `${Math.max(MARGIN, (viewport.width - size.width) / 2)}px`;
        return;
      }
      const { top, left } = placeAnchored(box, size, viewport, align);
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    };
    place();
    // The dismisser is read through the ref so an inline arrow from the parent
    // doesn't re-bind (and re-place) on every render; whether there is one at
    // all is fixed per call site.
    // No `anchor` passed: this component's anchor may be a rect snapshot with
    // no element behind it, and its triggers are buttons, not the text inputs
    // whose own overflow scroll the anchor guard exists for. Unchanged from
    // before the helper was extracted.
    return bindOverlayScroll({
      pop,
      place,
      onDismiss: onDismiss ? () => dismissRef.current?.() : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDismiss is read through dismissRef; depending on it would re-place on every parent render
  }, [mounted, anchor, align]);

  return createPortal(
    <div
      ref={setRef}
      className={`fixed z-50 ${className ?? ""}`}
      style={{ top: 0, left: 0 }}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}
