/**
 * Popover anchoring — real-layout regression cover for #195 and #203.
 *
 * These assertions cannot be made in jsdom: it reports every element as 0×0,
 * so clipping and viewport overflow are invisible there. A real browser is the
 * only place "the menu is cut off by its container" can actually be observed.
 *
 * The shared contract for every anchored popover:
 *   - it is portaled to <body>, so no ancestor's `overflow: hidden` clips it;
 *   - its box lies fully inside the viewport, flipping above its trigger when
 *     there isn't room below.
 */
import { test, expect } from "../fixtures";
import type { Locator, Page } from "@playwright/test";

/** Fails unless the element's box sits entirely within the viewport. */
async function expectOnScreen(page: Page, el: Locator, what: string): Promise<void> {
  const box = await el.boundingBox();
  expect(box, `${what}: expected a rendered box`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, "viewport size").not.toBeNull();
  const b = box!;
  const v = viewport!;
  expect.soft(b.x, `${what}: overflows the left edge`).toBeGreaterThanOrEqual(0);
  expect.soft(b.y, `${what}: overflows the top edge`).toBeGreaterThanOrEqual(0);
  expect.soft(b.x + b.width, `${what}: overflows the right edge`).toBeLessThanOrEqual(v.width);
  expect.soft(b.y + b.height, `${what}: overflows the bottom edge`).toBeLessThanOrEqual(v.height);
}

/** Fails unless the element is a direct child of <body> (i.e. portaled out). */
async function expectPortaled(el: Locator, what: string): Promise<void> {
  const parentIsBody = await el.evaluate((n) => n.parentElement === document.body);
  expect(parentIsBody, `${what}: expected it to be portaled to <body>`).toBe(true);
}

/**
 * Fails unless the element is actually the thing at its own centre point.
 *
 * This is the assertion that catches overflow clipping: a `boundingBox` is a
 * layout box and reports the same rect whether or not an ancestor's
 * `overflow: hidden` is painting over it. Hit-testing is what distinguishes
 * "laid out here" from "visible and clickable here" (#195).
 */
async function expectHittable(el: Locator, what: string): Promise<void> {
  const box = await el.boundingBox();
  expect(box, `${what}: expected a rendered box`).not.toBeNull();
  const b = box!;
  const hit = await el.evaluate(
    (node, point) => {
      const top = document.elementFromPoint(point.x, point.y);
      return top ? node.contains(top) || node === top : false;
    },
    { x: b.x + b.width / 2, y: b.y + b.height / 2 },
  );
  expect(hit, `${what}: not clickable at its own centre — something is covering or clipping it`).toBe(
    true,
  );
}

test("Sources: the bottom row's More actions menu is not clipped (#195)", async ({ page }) => {
  await page.goto("/app/default/sources");
  await expect(page.getByRole("navigation", { name: "Navigation" })).toBeVisible();

  // Schema groups render collapsed, so no source rows exist until expanded.
  // Scoped to <main>: the workspace switcher in the sidebar is also an
  // aria-expanded control and clicking it opens a modal over the page.
  // Wait for the groups to render — they arrive with the sources fetch, after
  // the shell is already on screen.
  await expect(page.locator("main button[aria-expanded]").first()).toBeVisible();
  const collapsed = page.locator('main button[aria-expanded="false"]');
  while ((await collapsed.count()) > 0) {
    await collapsed.first().click();
  }

  const triggers = page.getByRole("button", { name: "More actions" });
  await expect(triggers.first()).toBeVisible();
  const count = await triggers.count();

  // The last row is the one that sat against the card's overflow-hidden edge.
  await triggers.nth(count - 1).click();

  // Assert on the last menu item rather than the panel: "the bottommost items
  // aren't fully visible, so you can't reliably click every action" is the
  // reported symptom, and it survives markup changes to the panel itself.
  const lastItem = page.getByText("Remove source");
  await expect(lastItem).toBeVisible();
  await expectOnScreen(page, lastItem, "Remove source item");
  await expectHittable(lastItem, "Remove source item");

  const menu = page.getByRole("menu", { name: "More actions" });
  await expectPortaled(menu, "Sources ⋯ menu");
  await expectOnScreen(page, menu, "Sources ⋯ menu");
});

test("Show linked fields opens next to its column header, not in the corner (#203)", async ({
  page,
}) => {
  // The demo seed's Country table carries linked fields (region, currency)
  // and opens by default on this route.
  await page.goto("/app/default/tables");

  const pane = page.locator("div.absolute.inset-0:not([hidden])");
  const header = pane.locator('[data-header="region"]');
  await expect(header).toBeVisible();

  await header.getByRole("button", { name: "Column menu" }).click();
  await page.getByText("Show linked fields…").click();

  const dialog = page.getByRole("dialog", { name: "Manage linked fields" });
  await expect(dialog).toBeVisible();
  await expectOnScreen(page, dialog, "linked fields popup");
  await expectHittable(dialog, "linked fields popup");

  // The reported symptom: pinned to the top-left corner rather than anchored.
  const box = (await dialog.boundingBox())!;
  const headerBox = (await header.boundingBox())!;
  expect(box.x, "popup is pinned to the left edge").toBeGreaterThan(0);
  expect(box.y, "popup is pinned to the top edge").toBeGreaterThan(0);
  // Anchored means it tracks the header it was opened from.
  expect(Math.abs(box.x - headerBox.x), "popup is not aligned to its header").toBeLessThan(400);
});

test("Audit: the Who picker is portaled and on screen", async ({ page }) => {
  await page.goto("/app/default/audit");

  const trigger = page.getByRole("button", { name: /Who/ }).first();
  await expect(trigger).toBeVisible();
  await trigger.click();

  const panel = page.getByPlaceholder("Find a person…");
  await expect(panel).toBeVisible();

  // Typing must not dismiss the picker: once portaled, the panel is no longer
  // a descendant of the wrapper the outside-click handler tests.
  await panel.fill("e2e");
  await expect(panel).toBeVisible();

  const popover = page.locator("body > div").filter({ has: panel });
  await expectOnScreen(page, popover, "Who picker");
});
