/**
 * Journey #8 — workspace switcher + version history.
 *
 * Workspace provisioning: the e2e admin is NOT a super-admin, so the
 * POST /api/admin/tenants route is forbidden from this session. The switcher
 * is exercised with the single `default` workspace only. Switching to a second
 * workspace (and the URL-change assertion) is deferred until a super-admin
 * session is available in a later task.
 *
 * Version history: seeded tables have no published versions, so the panel
 * correctly shows "No versions published yet." A rollback assertion requires
 * at least two published versions and is deferred to Journey #3 (Task 6)
 * which creates and publishes content.
 */
import { test, expect } from "../fixtures";

test("workspace switcher opens and displays the current workspace", async ({ page }) => {
  await page.goto("/app/default");
  await expect(page.getByRole("navigation", { name: "Navigation" })).toBeVisible();

  // Open the switcher.
  await page.getByTestId("workspace-switcher").click();

  const dialog = page.getByRole("dialog", { name: "Switch workspace" });
  await expect(dialog).toBeVisible();

  // The "Current" section always shows the active workspace label.
  // The default workspace label may be "default" or a display name; we match
  // the slug text rendered in the Current row.
  await expect(dialog).toContainText("default", { ignoreCase: true });

  // The e2e admin belongs to exactly one workspace, so the "All workspaces"
  // section (which contains workspace-option-* testids for OTHER workspaces)
  // is not rendered. Asserting the switcher trigger is still present validates
  // the overall switcher contract.
  await expect(page.getByTestId("workspace-switcher")).toBeVisible();

  // Close via ESC.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("version history panel opens on a seeded table and shows its state", async ({ page }) => {
  // Navigate directly to the tables route; the app auto-opens the first table.
  await page.goto("/app/default/tables");

  // Wait for a TablePane to render — the toolbar's "More actions" button
  // is the reliable signal that a pane is visible and fully mounted.
  const moreActionsButton = page.getByRole("button", { name: "More actions" });
  await expect(moreActionsButton).toBeVisible();

  // Open the toolbar overflow menu.
  await moreActionsButton.click();

  // Click "Version history" in the menu.
  await page.getByTestId("version-history-button").click();

  // The history panel should render with its section heading (exact match to
  // avoid the "Versions published before version history existed…" footnote).
  await expect(page.getByText("Version history", { exact: true })).toBeVisible();

  // Seeded tables have no published versions yet.
  await expect(page.getByText("No versions published yet.")).toBeVisible();

  // Close the panel.
  await page.getByRole("button", { name: "Close version history" }).click();
  await expect(page.getByText("Version history", { exact: true })).not.toBeVisible();
});
