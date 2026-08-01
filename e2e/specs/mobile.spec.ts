import { test, expect } from "@playwright/test";

const SLUG = "default";

test("review: the value pane scrolls on a phone", async ({ page }) => {
  await page.goto(`/app/${SLUG}/triage`);
  await page.getByText("Country", { exact: false }).first().click();
  await expect(page.getByText("Choose record").first()).toBeVisible();

  const pane = page.locator(".min-h-0.flex-1.overflow-auto").first();
  const box = await pane.evaluate((el) => ({
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));

  // The pane must be bounded by the viewport, not grown to content height.
  expect(box.clientH).toBeLessThan(844);
  expect(box.scrollH).toBeGreaterThan(box.clientH);
});

test("popovers close on scroll instead of sliding around", async ({ page }) => {
  await page.goto(`/app/${SLUG}/sources`);
  await page.getByText("Raw", { exact: false }).first().click();

  const menuButton = page.getByRole("button", { name: "More actions" }).first();
  await menuButton.click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu).toBeVisible();

  await page.evaluate(() => {
    document.querySelector("#main")?.scrollBy(0, 250);
  });

  await expect(menu).toBeHidden();
});
