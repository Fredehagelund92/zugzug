/**
 * Journey #8 — workspace switcher + version history.
 *
 * Workspace provisioning: the e2e admin is NOT a super-admin, so the
 * POST /api/admin/tenants route is forbidden from this session. The switcher
 * is exercised with the single `default` workspace only. Switching to a second
 * workspace (and the URL-change assertion) is deferred until a super-admin
 * session is available in a later task.
 *
 * Version history: the test creates its own fresh table so it is fully
 * independent of other specs. A rollback assertion requires at least two
 * published versions and is deferred to Journey #3 (Task 6) which creates
 * and publishes content.
 */
import { test, expect, uniqueSuffix } from "../fixtures";

test("workspace switcher opens and displays the current workspace", async ({ page }) => {
  await page.goto("/app/default");
  await expect(page.getByRole("navigation", { name: "Navigation" })).toBeVisible();

  // The switcher trigger's first direct <span> child renders the current
  // workspace's *label* (the avatar is a sibling <div>, the "▾" caret a
  // trailing <span>). Read it before opening, so we can assert the dialog
  // shows the same text.
  const triggerLabel = await page
    .getByTestId("workspace-switcher")
    .locator("> span")
    .first()
    .innerText();

  // Open the switcher.
  await page.getByTestId("workspace-switcher").click();

  const dialog = page.getByRole("dialog", { name: "Switch workspace" });
  await expect(dialog).toBeVisible();

  // The "Current" section renders the same workspace *label* and role — never
  // the slug. The label itself is seed-dependent (migration 0011 backfills
  // "Default" on a fresh CI database; demo-reset overwrites it to "Demo
  // workspace" on a long-lived local stack), so assert against whatever the
  // trigger displayed rather than hardcoding either string.
  await expect(dialog).toContainText(triggerLabel);

  // The e2e admin belongs to exactly one workspace, so the "All workspaces"
  // section (which contains workspace-option-* testids for OTHER workspaces)
  // is not rendered. Asserting the switcher trigger is still present validates
  // the overall switcher contract.
  await expect(page.getByTestId("workspace-switcher")).toBeVisible();

  // Close via ESC.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("version history panel opens on a fresh table and shows its state", async ({ page }) => {
  const tableName = `E2E VersionHistory ${uniqueSuffix()}`;

  await page.goto("/app/default/tables");
  // Wait for the tab strip to boot.
  await expect(page.getByRole("button", { name: "Open table" })).toBeVisible();

  // Create a fresh table via the tab-strip create flow.
  await page.getByRole("button", { name: "Open table" }).click();
  await page.getByTestId("create-table-button").click();

  const dialog = page.getByRole("dialog", { name: /new table/i });
  await expect(dialog).toBeVisible();

  const radioGroup = dialog.getByRole("radiogroup", { name: "Start from" });
  await radioGroup.getByRole("radio", { name: /empty table/i }).click();

  await dialog.getByPlaceholder("Name this table").fill(tableName);
  await dialog.getByRole("button", { name: "Create table" }).click();

  // Confirm the new table is active in the tab strip.
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("tablist").getByText(tableName)).toBeVisible();

  // Wait for the TablePane toolbar to mount before interacting with it.
  const moreActionsButton = page.getByRole("button", { name: "More actions" });
  await expect(moreActionsButton).toBeVisible();

  // Open the toolbar overflow menu.
  await moreActionsButton.click();

  // Click "Version history" in the menu.
  await page.getByTestId("version-history-button").click();

  // The history panel should render with its section heading (exact match to
  // avoid the "Versions published before version history existed…" footnote).
  await expect(page.getByText("Version history", { exact: true })).toBeVisible();

  // A brand-new table has no published versions.
  await expect(page.getByText("No versions published yet.")).toBeVisible();

  // Close the panel.
  await page.getByRole("button", { name: "Close version history" }).click();
  await expect(page.getByText("Version history", { exact: true })).not.toBeVisible();
});

/* The Review page's route was "triage" until the vocabulary sweep; the word is
   banned from anything a user sees, and it was visible in the address bar and in
   every shared link. The rename keeps a redirect so those old links still work —
   this asserts the redirect end to end, since a stale bookmark is exactly the
   case a unit test on the route table cannot prove. */
test("a link to the old Review address still lands on the page", async ({ page }) => {
  await page.goto("/app/default/triage");
  await page.waitForLoadState("networkidle");

  await expect(page).toHaveURL(/\/app\/default\/review$/);
  await expect(page.locator("#main")).toBeVisible();
  // Proves the page really rendered rather than redirecting to an empty shell.
  await expect(page.locator("#main")).not.toBeEmpty();
});
