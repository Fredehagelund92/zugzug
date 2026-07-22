/**
 * Journey #3 — edit a record in the DataGrid, publish, assert the version bumps.
 *
 * Each run creates its own table + record so parallel/previous runs don't collide.
 * The grid edit targets the `label` cell (always a text input when editing), which
 * keeps us away from select/date editors that open popovers.
 *
 * The app renders all open tab panes simultaneously but marks inactive ones with
 * the HTML `hidden` attribute. We scope every interaction to the active pane
 * (`div.absolute.inset-0:not([hidden])`) to avoid strict-mode violations when
 * multiple `publish-button` elements exist across tabs.
 */
import { test, expect, uniqueSuffix } from "../fixtures";

test("edit a record in the grid, publish, and assert version bumps", async ({ page }) => {
  const suffix = uniqueSuffix();
  const tableName = `E2E Publish ${suffix}`;
  const initialLabel = `Alpha ${suffix}`;
  const editedLabel = `Alpha Edited ${suffix}`;

  // ── 1. Create a fresh table ──────────────────────────────────────────────
  await page.goto("/app/default/tables");
  await expect(page.getByRole("button", { name: "Open table" })).toBeVisible();

  await page.getByRole("button", { name: "Open table" }).click();
  await page.getByTestId("create-table-button").click();

  const dialog = page.getByRole("dialog", { name: /new table/i });
  await expect(dialog).toBeVisible();

  const radioGroup = dialog.getByRole("radiogroup", { name: "Start from" });
  await radioGroup.getByRole("radio", { name: /empty table/i }).click();
  await dialog.getByPlaceholder("Name this table").fill(tableName);
  await dialog.getByRole("button", { name: "Create table" }).click();

  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("tablist").getByText(tableName)).toBeVisible();

  // The active tab pane is the wrapper div that does NOT carry the `hidden`
  // attribute (inactive panes are hidden via the HTML `hidden` attribute).
  // We scope all further pane-level interactions through this locator.
  const activePaneWrapper = page.locator("div.absolute.inset-0:not([hidden])");

  // ── 2. Add an initial record via the add-record input ───────────────────
  const addInput = activePaneWrapper.getByPlaceholder(`new ${tableName.toLowerCase()} record…`);
  await expect(addInput).toBeVisible();
  await addInput.fill(initialLabel);
  await activePaneWrapper.getByRole("button", { name: "Add record" }).click();

  // Wait for the record to appear in the grid.
  const cell = activePaneWrapper
    .locator(`[data-cell$="::label"]`)
    .filter({ hasText: initialLabel });
  await expect(cell).toBeVisible();

  // ── 3. Publish the initial draft to establish a v1 baseline ─────────────
  // Adding a record creates a draft (pendingDrafts = 1), so the publish button
  // should be visible now.
  const publishBtn = activePaneWrapper.getByTestId("publish-button");
  await expect(publishBtn).toBeVisible();
  await expect(publishBtn).toHaveText(/Publish \d+ change/);

  await publishBtn.click();

  // The PublishPreviewDialog is a portal (renders in document.body) so we
  // query it on the page, not from within the pane scope.
  const previewDialog = page.getByRole("dialog", { name: /publish v/i });
  await expect(previewDialog).toBeVisible();
  await previewDialog.getByRole("button", { name: "Publish" }).click();
  await expect(previewDialog).not.toBeVisible();

  // After publishing there are no pending changes — the button hides.
  await expect(publishBtn).not.toBeVisible();

  // ── 4. Edit the label cell in the DataGrid ───────────────────────────────
  // Double-click the label cell to enter edit mode. The label column uses a
  // custom <input> editor that commits on Enter or blur.
  await cell.dblclick();

  // When the cell enters edit mode its text span is replaced by an <input>.
  // The `cell` locator's `hasText` filter no longer matches (the input value
  // isn't counted as text content), so we look for the input inside any
  // gridcell in the active pane instead.
  const cellInput = activePaneWrapper.locator('[role="gridcell"] input').first();
  await expect(cellInput).toBeVisible();

  await cellInput.fill(editedLabel);

  // Commit with Enter — the label cell's onKeyDown calls commit(); the grid's
  // cursor handler then calls stopEdit + move(0, 1) + startEdit(). Because
  // there is only one row, the cursor stays on the same row and immediately
  // re-enters edit mode. Press Escape afterwards to exit the re-entered
  // editing state so the cell renders as text again.
  await cellInput.press("Enter");
  await page.keyboard.press("Escape");

  // Confirm the cell now shows the edited label as a text span (not in edit
  // mode) before checking publish state.
  const editedCell = activePaneWrapper
    .locator(`[data-cell$="::label"]`)
    .filter({ hasText: editedLabel });
  await expect(editedCell).toBeVisible();

  // ── 5. Assert the publish button shows the pending edit ──────────────────
  await expect(publishBtn).toBeVisible();
  await expect(publishBtn).toHaveText(/Publish \d+ change/);

  // ── 6. Click publish → confirm in the preview dialog ────────────────────
  await publishBtn.click();

  const publishDialog = page.getByRole("dialog", { name: /publish v/i });
  await expect(publishDialog).toBeVisible();
  await publishDialog.getByRole("button", { name: "Publish" }).click();
  await expect(publishDialog).not.toBeVisible();

  // After the second publish the button disappears again.
  await expect(publishBtn).not.toBeVisible();

  // ── 7. Assert the version bumped via Version History ─────────────────────
  // "Version history" is inside the "⋯" (More actions) ToolbarMenu.
  // The menu is a portal, so the menu item itself appears in document.body.
  await activePaneWrapper.getByTitle("More actions").click();
  await page.getByTestId("version-history-button").click();

  // The version history panel renders inline inside the active pane.
  // Use exact match to avoid the disclaimer footer text also matching.
  const historyPanel = activePaneWrapper.getByText("Version history", { exact: true });
  await expect(historyPanel).toBeVisible();

  // We published twice (v1 = initial record, v2 = label edit), so the
  // version history must show a v2 entry. The version entry renders as
  // <span class="font-semibold text-ink">v{version}</span> inside the panel.
  // Wait for the async fetch to finish (panel starts in "Loading…" state).
  await expect(
    activePaneWrapper.locator("span.font-semibold.text-ink").filter({ hasText: /^v2$/ }),
  ).toBeVisible();
});
