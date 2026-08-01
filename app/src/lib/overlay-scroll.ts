/** How long after opening an overlay ignores scrolls for dismissal purposes. */
export const ARM_DELAY_MS = 100;

export interface OverlayScrollOptions {
  /** The portaled panel itself. */
  pop: HTMLElement;
  /** The trigger the panel is placed against, when there is one. */
  anchor?: HTMLElement | null;
  /** Re-run the panel's own positioning. */
  place: () => void;
  /** Close the panel. Omit and the panel keeps re-placing, as it always did. */
  onDismiss?: () => void;
}

/**
 * Wires an open portaled overlay to the page's scroll and resize.
 *
 * Re-places on resize. On scroll it dismisses instead of chasing its anchor —
 * dragging a menu around the screen while the user scrolls is worse than
 * closing it. Two exceptions re-place rather than dismiss:
 *
 * - The scroll came from inside the panel or inside its anchor. Several of
 *   these panels have their own inner scrollers, and a text input scrolls
 *   *itself* once its content overflows horizontally — reading that as "the
 *   page moved" would dismiss an editor mid-typing.
 * - The overlay opened less than ARM_DELAY_MS ago. Consumers focus something
 *   inside the panel in a later effect, and the browser's scroll-into-view
 *   would otherwise dismiss the panel in the moment it opened (measured at
 *   ~106px on the demo grid at 390px). A timer rather than
 *   requestAnimationFrame: rAF only runs when the page paints, so on a quiet
 *   page the arming can be deferred past the very scroll it exists to cover.
 *   That was tried and rejected. Nobody opens a menu and scrolls this fast.
 *
 * Returns the cleanup to call from the effect that bound it.
 */
export function bindOverlayScroll({
  pop,
  anchor,
  place,
  onDismiss,
}: OverlayScrollOptions): () => void {
  let armed = false;
  const arm = window.setTimeout(() => {
    armed = true;
  }, ARM_DELAY_MS);
  const onScroll = (e: Event) => {
    const target = e.target as Node | null;
    const inside =
      target != null &&
      target !== document &&
      (pop.contains(target) || anchor?.contains(target) === true);
    if (armed && onDismiss && !inside) onDismiss();
    else place();
  };
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", place);
  return () => {
    window.clearTimeout(arm);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", place);
  };
}
