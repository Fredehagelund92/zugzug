import { test, expect } from "@playwright/test";

test("signed-in admin lands in the default workspace", async ({ page }) => {
  await page.goto("/app/default");
  await expect(page).toHaveURL(/\/app\/default/);
  // The authed shell renders a sidebar nav once boot is complete.
  await expect(page.getByRole("navigation", { name: "Navigation" })).toBeVisible();
});
