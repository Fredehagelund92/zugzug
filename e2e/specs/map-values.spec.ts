/**
 * Journey #4 — seed source values → map in Review → publish.
 *
 * Path B: the demo stack runs with ATTACH_WAREHOUSE=false, so a real warehouse
 * scan is not available. Instead, this spec seeds `source_scan_value` rows via
 * POST /api/e2e/seed-scan-values (workspace-admin gated) to simulate the output
 * of a scan, then exercises the high-value map→publish flow end-to-end.
 *
 * The warehouse "scan trigger" itself (Sources UI → POST /api/sources/scan)
 * requires a live warehouse adapter and is out of scope for the default E2E
 * stack.
 *
 * The Review page is a table rail (left) + detail pane (right): each table with
 * values still to map is a rail <button> "<name> <count>"; selecting it opens
 * that table's values as <li role="row"> entries with a per-row record picker.
 */
import { test, expect, uniqueSuffix } from "../fixtures";

/** The demo stack seeds a "Country" refTable with record records already in
 *  place. We plant a raw value not yet in map_country so the Review page shows
 *  it as still-to-map. */
const SEED_DIM_ID = "country";
const SEED_TABLE = "e2e.seed_countries";
const SEED_COLUMN = "country_name";

test("seed source values, map in Review, and publish", async ({ page, request }) => {
  const suffix = uniqueSuffix();
  // Use a raw value that is definitely not in map_country yet (unique per run).
  const rawValue = `E2E Country ${suffix}`;
  // We'll map it to "Australia" (a stable record label from the demo seed).
  const targetLabel = "Australia";

  // ── 1. Seed source_scan_value rows via the E2E helper endpoint ───────────────
  // This simulates what a warehouse scan would produce. The endpoint is
  // workspace-admin gated; the E2E admin session satisfies that requirement.
  const seedResp = await request.post("/api/e2e/seed-scan-values", {
    data: {
      refTableId: SEED_DIM_ID,
      occurrences: [
        {
          raw: rawValue,
          table: SEED_TABLE,
          column: SEED_COLUMN,
          rows: 42,
        },
      ],
    },
  });
  expect(seedResp.ok(), `seed endpoint returned ${seedResp.status()}`).toBe(true);

  // ── 2. Navigate to the Review page ────────────────────────────────────────
  await page.goto("/app/default/triage");

  // Each table with values still to map is a rail <button> labelled
  // "<name> <count>" — e.g. "Country 1" now that we seeded one unmapped value.
  const countryRailBtn = page.getByRole("button", { name: /^Country\b/ }).first();
  await expect(countryRailBtn).toBeVisible({ timeout: 15_000 });

  // ── 3. Activate the Country table ─────────────────────────────────────────
  // Clicking the rail button opens that table's values in the detail pane.
  await countryRailBtn.click();

  // ── 4. Find the seeded row in the list ────────────────────────────────────
  // Each value renders as <li role="row"> containing the raw value text. A
  // still-unmapped row has no status chip — it shows the picker and a "Skip".
  const row = page.locator('[role="row"]').filter({ hasText: rawValue }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByRole("button", { name: "Skip" })).toBeVisible();

  // ── 5. Open the mapping picker ────────────────────────────────────────────
  // Each row renders a ComboSelect trigger button, aria-labelled
  // "Choose record for <raw>". Clicking it opens the portalled dropdown with a
  // role="combobox" search input.
  const selectTrigger = row.getByRole("button", { name: `Choose record for ${rawValue}` });
  await expect(selectTrigger).toBeVisible({ timeout: 3_000 });
  await selectTrigger.click();

  const comboInput = page.locator('[role="combobox"]');
  await expect(comboInput).toBeVisible({ timeout: 5_000 });

  // ── 6. Search for and pick the target record label ─────────────────────
  await comboInput.fill(targetLabel);
  const option = page.locator('[role="option"]', { hasText: targetLabel }).first();
  await expect(option).toBeVisible();
  await option.click();

  // ── 7. Assert the row now shows the "Mapped" chip + target label ──────────
  await expect(row.getByText("Mapped")).toBeVisible({ timeout: 5_000 });
  await expect(row.getByText(targetLabel)).toBeVisible();

  // ── 8. Open the publish preview ───────────────────────────────────────────
  // The footer shows "Publish" when there are pending drafts and no warehouse.
  const publishBtn = page.getByRole("button", { name: /^Publish/ }).last();
  await expect(publishBtn).toBeVisible({ timeout: 5_000 });
  await expect(publishBtn).not.toBeDisabled();
  await publishBtn.click();

  // ── 9. Confirm in the PublishPreviewDialog ────────────────────────────────
  // The demo seed leaves in-review drafts in several tables, so the footer
  // Publish opens the aggregate dialog ("Publish N tables?"); with a single
  // table pending it's titled "Publish vN". Match either.
  const previewDialog = page.getByRole("dialog", { name: /^publish/i });
  await expect(previewDialog).toBeVisible({ timeout: 5_000 });

  // The dialog lists the raw value being published.
  await expect(previewDialog.getByText(rawValue)).toBeVisible();

  // Confirm.
  await previewDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(previewDialog).not.toBeVisible({ timeout: 10_000 });

  // ── 10. Assert the mapping is published ───────────────────────────────────
  // Publishing cleared Country's "to map" queue, so re-open it from the rail
  // and switch to its "already mapped" peek — the "· N mapped ✓" button in the
  // detail header — to confirm the value landed as a published mapping.
  await page.reload();
  const countryAfter = page.getByRole("button", { name: /^Country\b/ }).first();
  await expect(countryAfter).toBeVisible({ timeout: 15_000 });
  await countryAfter.click();

  const mappedPeek = page.getByRole("button", { name: /\d+ mapped/ }).first();
  await expect(mappedPeek).toBeVisible({ timeout: 10_000 });
  await mappedPeek.click();

  // Filter the (paginated) mapped list down to our unique value so its row is
  // guaranteed to render regardless of how many mapped values the table has.
  await page.getByRole("searchbox", { name: /search/i }).fill(rawValue);

  const publishedRow = page.locator('[role="row"]').filter({ hasText: rawValue }).first();
  await expect(publishedRow).toBeVisible({ timeout: 10_000 });
  await expect(publishedRow.getByText("Mapped")).toBeVisible();
  await expect(publishedRow.getByText(targetLabel)).toBeVisible();
});
