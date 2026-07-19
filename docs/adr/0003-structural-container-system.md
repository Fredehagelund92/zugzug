# Container surfaces are structural, not semantic

Document pages had drifted: each hand-rolled its own frame (width, padding) and its own bordered boxes, picking `--surface` (white) vs `--surface-2` (gray) ad hoc — Settings used white panels with gray insets, Integrations used the exact inverse, and the same "activity log" rendered at two different widths in the tenant vs admin shells. We standardized on two primitives — `Panel` (the one container) and `PageContainer` (the one page frame) — and made surface tint a pure function of **nesting depth**: page = `--bg`, panel-on-page = `--surface`, inset-in-panel = `--surface-2`, overlay = `--surface-elevated`. Shadow signals "floating above the page" and is reserved for overlays; in-page panels never cast one.

The rejected alternative was **semantic** color — gray = secondary/help/disabled, white = primary. It's more expressive but every container becomes a judgment call, which is exactly how the drift happened. We chose mechanical enforceability over expressiveness: a reviewer can verify tint by looking at the DOM depth, not by reasoning about meaning. This is why a help/reference block is white, not gray — depth, not role, decides.

## Consequences

- The `Card` component is deleted; `Panel padding="md"` replaces it. One vocabulary, no "Card vs Panel" seam.
- Radius standardization is **code hygiene only** — square-mode (`globals.css`) forces all container radii to `0`, so normalizing `rounded-*` classes changes no pixels. Corners are square by brand intent and that is permanent. **[Superseded by ADR-0004: square-mode is retired; corners now render rounded at the brand's `4/8/12` scale and `rounded-*` utilities are live again. The container/tint/shadow model here otherwise still holds.]**
- In-page panels lose shadows (including the old `Card`'s), aligning with DESIGN.md's "no shadow on the lattice ground." Elevation now unambiguously means overlay.
- **The grid pages — Sources, Review, Master tables — are exempt.** They are bespoke full-width, full-height, internally-scrolling grid experiences; forcing them through `PageContainer`/`Panel` would break the grid. This exemption is deliberate — do not "finish the job" by standardizing them.
- `--maxw` (1180) is retired; document pages cap at `--wide` (1320), matching what the code already did. DESIGN.md §5 corrected to match. **[Amended by ADR-0004: single-column document pages (tenant settings, Account) now cap at the narrower `--doc` (1040); table-dominant pages (admin console, Activity log) stay at `--wide`.]**
