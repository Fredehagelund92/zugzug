# Grid Wave 2 Design: Delete Table, Presence Cursors, Grid A11y

Audit items 1.7, 1.8, 1.9 from `docs/grid-next-level-plan.md`. Approved 2026-07-12 (hard delete + typed confirm; full wave scope).

## 1. Delete table (hard delete, typed confirmation)

**Problem.** Tables can be created but never removed — no UI affordance and no API route. Experiments permanently pollute the workspace.

**Decision.** Hard delete with a type-the-name confirmation. No archive tier: deleting a table is an explicit, destructive act; anything downstream (dbt models reading `dim_x`) breaking is the point of deleting.

### Server

- New route: `DELETE /api/t/<slug>/dimensions/:id`, gated exactly like table create/edit (`gateOrJson(tenantCtx, "curate")`).
- One Postgres transaction deletes, in order: `dimension_source`, `dimension_field`, `draft`, `source_stat`, `user_grid_layout`, `ai_hint_cache`, `canonical_version`, then the `dimension` row. (No FK cascades exist — explicit sweeps, schema audit in the fact-finding report.)
- **Kept on purpose:** `audit` and `outbound_event` rows (history outlives the table). A final audit entry records the deletion (actor, table name, record count).
- Warehouse `DROP TABLE IF EXISTS <schema>.dim_<id>` and `map_<id>` run best-effort **after** the transaction commits. Unreachable/detached warehouse does not fail the delete; the response reports `{ ok: true, warehouseDropped: boolean }`.
- 404 for unknown id; the tenant scoping comes from the route context like every other dimension route.

### Client

- Entry point: right-click on a table tab (TabItem gains `onContextMenu`), opening the existing datagrid `ContextMenu` component with two items: **Close tab** and **Delete table…**. No new toolbar button (toolbar crowding is a known craft issue).
- **Delete table…** opens the existing `ConfirmDialog` with its `confirmPhrase` prop (same pattern as RemoveDatabaseConfirm): the user must type the table's display name. Copy (plain vocabulary):
  > Permanently delete **<Name>**? Its <N> records and their mappings are deleted. Anything reading `dim_<id>` from the warehouse will break. This cannot be undone.
- On confirm: store `deleteDimension(dimId)` → `DELETE` API → remove from the local dims cache, close the tab, success toast ("Deleted <Name>." — plus " Warehouse tables could not be dropped." when `warehouseDropped` is false).
- Permission: menu item hidden unless the user can edit (same `useCanEdit` gate as create).

## 2. Presence cursors publish record keys (not positions)

**Problem.** A peer's cursor is published as `{row, col}` — indices into the *sender's* sorted/filtered rows — and resolved against the *receiver's* ordering. Two users with different sorts see each other's cursors on the wrong records.

**Design.**
- `PeerState.cell` becomes `{ rowKey: string; field: string } | null`. `usePresence.setCell(rowKey, field)` replaces the index pair.
- DataGrid's publish effect sends the cursor's `rowKey`/`field` directly (deleting the index lookups). `CursorOverlay` resolves the peer cell to pixels via the existing `[data-cell="<rk>::<field>"]` DOM machinery (attrEsc). A key that isn't rendered (filtered out, scrolled beyond the virtualization window, or deleted) renders no cursor — correct behavior.
- Old-shape payloads (`{row, col}` from a peer that hasn't reloaded) are ignored (shape check), giving one-release mixed-version tolerance. The server relays opaque awareness bytes — no server change.
- **Documented limitation:** peer *selection ranges* remain index-based and can still misplace under differing sorts; a rectangle cannot be faithfully mapped across orderings. Only the cursor is fixed in this wave.

## 3. Grid a11y: active-cell exposure + keyboard exit

**Problem.** The grid container never exposes which cell is active (`aria-activedescendant` absent; cells have no `id`), so screen readers announce nothing as the cursor moves. Tab is fully trapped (always commits + moves right); there is no keyboard way out of the grid.

**Design.**
- Each GridCell gets a stable, document-unique `id`: a per-grid prefix from `useId()` in DataGrid + rowKey + field, threaded down through GridRow (multiple grids can be mounted across hidden tabs, so the prefix is required).
- The `role="grid"` container sets `aria-activedescendant` to the focused cell's id whenever the cursor is set (and removes it when not).
- **Escape when not editing clears the cursor.** With no cursor, `useGridCursor`'s key handler already bails, so the next Tab falls through to the browser and focus leaves the grid — the standard ARIA-grid escape hatch, without giving up the spreadsheet Tab-moves-right convention during normal navigation.
- Existing `aria-rowindex`/`aria-colindex`/`aria-selected`/`aria-rowcount`/`aria-colcount` are already correct and untouched.

## Testing

- **Server:** bun test against the docker test Postgres (existing `repo-*` pattern): delete sweeps all operational tables, keeps audit rows, writes the deletion audit entry, 404 on unknown id, gate enforced.
- **Client (jsdom):** tab context menu opens and gates Delete behind the typed phrase (ConfirmDialog `confirmPhrase`); store delete removes the dim and closes the tab; presence publish sends `{rowKey, field}` and ignores legacy shapes; grid sets/clears `aria-activedescendant`; Escape-then-Tab leaves the grid.
- **Live probe:** delete `audit_scratch` for real (the one intentional data mutation — it removes the audit leftover), verify presence shape on the wire, and walk the keyboard exit.

## Out of scope

- Archive/restore tier; bulk delete; renaming `dim_x` on delete.
- Selection-range presence fidelity across sorts (documented limitation).
- Announcing cell *values* via live regions (activedescendant covers position + content reading).
