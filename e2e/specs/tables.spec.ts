/**
 * Journey #2 — create a reference table.
 *
 * The create-table flow is reached via the tab strip's "Open table" (+) button →
 * "New table" popover item (carrying the `create-table-button` testid), which
 * opens the `CreateTableModal`.
 */
import { test, expect, uniqueSuffix } from "../fixtures";

test("create an empty table and see it in the tab strip", async ({ page }) => {
  const tableName = `E2E Vendors ${uniqueSuffix()}`;

  await page.goto("/app/default/tables");
  // Wait for the table view to boot (tab strip renders once refTables are loaded).
  await expect(page.getByRole("button", { name: "Open table" })).toBeVisible();

  // Click the + button in the tab strip to open the "add tab" popover.
  await page.getByRole("button", { name: "Open table" }).click();

  // Click "New table" in the popover (via the create-table-button testid).
  await page.getByTestId("create-table-button").click();

  // The create-table dialog opens.
  const dialog = page.getByRole("dialog", { name: /new table/i });
  await expect(dialog).toBeVisible();

  // Pick "Empty table" in the "Start from" radiogroup.
  const radioGroup = dialog.getByRole("radiogroup", { name: "Start from" });
  await radioGroup.getByRole("radio", { name: /empty table/i }).click();

  // Fill the unique table name.
  await dialog.getByPlaceholder("Name this table").fill(tableName);

  // Submit.
  await dialog.getByRole("button", { name: "Create table" }).click();

  // After submission the dialog closes and the new table appears as a tab in the tab strip.
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("tablist").getByText(tableName)).toBeVisible();
});
