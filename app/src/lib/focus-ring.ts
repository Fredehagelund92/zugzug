/** Shared keyboard focus indicator, matching the `Button` component's ring, for
 *  hand-rolled interactive controls (checkboxes, tree rows, list buttons) that
 *  otherwise only style :hover — so keyboard users get the same feedback (#160). */
export const focusRing =
  "focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]";
