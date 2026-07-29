/**
 * Linked-field picker — real-layout cover for #202.
 *
 * The candidates were always in the DOM; they were invisible. Rows are
 * absolutely positioned and the container height + per-row offsets were
 * applied only on the virtualized path, which deadlocks in a real browser:
 * the virtualizer yields no items until the scroll element has height, and it
 * has no height until those offsets are applied.
 *
 * jsdom cannot catch this — its stubbed getBoundingClientRect gives every
 * element a non-zero box, so tests there take the virtualized path and pass.
 * Only a real layout engine reproduces it.
 */
import { test, expect } from "../fixtures";

test("linked field picker shows and commits a candidate (#202)", async ({ page }) => {
  await page.goto("/app/default/tables");

  const pane = page.locator("div.absolute.inset-0:not([hidden])");
  await expect(pane.locator('[data-header="region"]')).toBeVisible();

  const cell = pane.locator('[data-cell$="::region"]').first();
  await expect(cell).toBeVisible();
  await cell.click();
  await cell.dblclick();

  // NB: the table toolbar also uses the "Search records…" placeholder, but only
  // the picker is portaled into a `fixed` container, which disambiguates it.
  // Identify it structurally — a content-based locator stops matching as soon
  // as the search filters the list.
  const picker = page
    .locator("div.fixed")
    .filter({ has: page.getByPlaceholder("Search records…") })
    .first();
  await expect(picker).toBeVisible();
  const search = picker.getByPlaceholder("Search records…");
  await expect(search).toBeVisible();

  // The reported symptom: the list is empty. It must show the linked table's
  // records, and they must be actually visible — not stacked at zero height.
  const option = picker.getByRole("button", { name: /Nordics/ });
  await expect(option).toBeVisible();

  const box = await option.boundingBox();
  expect(box, "candidate row has no rendered box").not.toBeNull();
  expect(box!.height, "candidate rows collapsed to zero height").toBeGreaterThan(0);

  // Rows must not all stack on top of each other.
  const first = await picker.getByRole("button", { name: /APAC/ }).boundingBox();
  expect(first, "first candidate has no box").not.toBeNull();
  expect(
    Math.abs(first!.y - box!.y),
    "candidate rows are stacked at the same offset",
  ).toBeGreaterThan(0);

  // Filtering still works, and picking commits.
  await search.fill("nord");
  await expect(picker.getByRole("button", { name: /Nordics/ })).toBeVisible();
  await picker.getByRole("button", { name: /Nordics/ }).click();

  await expect(picker).toBeHidden();
  await expect(cell).toContainText("Nordics");
});
