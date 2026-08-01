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

/* Touch-scrolling the page behind an open dropdown used to drag the dropdown
   across the screen, because every popover re-placed itself against its anchor
   on every scroll. It now closes instead — but only for a scroll of the page,
   not of the popover's own list (#197).

   The Activity page is the mobile home for this: its timeline overflows a phone
   viewport (the Sources page does not, so a scroll there is a no-op that would
   assert nothing) and its Who picker has an inner scroller of its own. */
test("a page scroll closes an open popover; scrolling its own list does not", async ({ page }) => {
  await page.goto(`/app/${SLUG}/audit`);
  // Wait for the timeline before opening anything: the page must already
  // overflow, or the scroll below is a no-op that would assert nothing.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const m = document.querySelector("#main");
        return m ? m.scrollHeight - m.clientHeight : 0;
      }),
    )
    .toBeGreaterThan(250);

  await page.getByRole("button", { name: /Who/ }).first().click();
  const panel = page.getByPlaceholder("Find a person…");
  await expect(panel).toBeVisible();
  // A popover ignores scrolls for its first ARM_DELAY_MS (AnchoredPopover), so
  // the browser scrolling a freshly focused input into view can't close it the
  // instant it opens. A person cannot scroll that fast; this test can.
  await page.waitForTimeout(250);

  // Scrolling the picker's own list must leave it open.
  await page.evaluate(() => {
    const list = document.querySelector("body > div ul.overflow-auto");
    list?.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await expect(panel).toBeVisible();

  // Scrolling the page underneath it must close it.
  const scrolled = await page.evaluate(() => {
    const main = document.querySelector("#main");
    if (!main) return 0;
    main.scrollBy(0, 250);
    return main.scrollTop;
  });
  expect(scrolled, "the page must really scroll for this to test anything").toBeGreaterThan(0);

  await expect(panel).toBeHidden();
});

test("source rows fit the screen and keep their actions reachable", async ({ page }) => {
  await page.goto(`/app/${SLUG}/sources`);
  await page.getByText("Raw", { exact: false }).first().click();

  const menuButton = page.getByRole("button", { name: "More actions" }).first();
  await expect(menuButton).toBeInViewport();

  // No row may be wider than the card that holds it.
  const overflowing = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[class*="grid-cols-"]'))
      .filter((el) => el.scrollWidth > el.clientWidth + 2).length,
  );
  expect(overflowing).toBe(0);
});
