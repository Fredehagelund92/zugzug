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
 */
import { test, expect, uniqueSuffix } from "../fixtures";

/** The demo stack seeds a "Country" refTable with record records already in
 *  place. We plant a raw value not yet in map_country so the Review page shows
 *  it as "New". */
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

  // The "Needs review" filter is the default; wait for the Country section to
  // appear (newCount > 0 because we just seeded a raw value).
  const countrySection = page.locator("section").filter({ hasText: "Country" }).first();
  await expect(countrySection).toBeVisible({ timeout: 15_000 });

  // ── 3. Expand / activate the Country section ──────────────────────────────
  // The section header is a <button> inside the <section>. If it shows
  // "▸ expand" it is not yet active; click to activate it.
  const sectionToggle = countrySection.locator("button").first();
  await expect(sectionToggle).toBeVisible();

  // Only click if not already active (idempotent for the active first section).
  const toggleText = await sectionToggle.textContent();
  if (toggleText?.includes("expand")) {
    await sectionToggle.click();
  }

  // ── 4. Find the seeded row in the list ────────────────────────────────────
  // Each unmapped value renders as <li role="row"> containing the raw value text.
  const row = page.locator('[role="row"]').filter({ hasText: rawValue }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // The row should show a "New" chip (unmapped).
  await expect(row.getByText("New")).toBeVisible();

  // ── 5. Open the mapping picker ────────────────────────────────────────────
  // The li has tabIndex=0; clicking it moves cursor focus (setCursor state).
  // Pressing "m" triggers onKeyDown → setEditingRaw(raw), which reveals the
  // ComboSelect trigger button ("Select…"). Clicking that trigger opens the
  // dropdown and shows the combobox search input.
  await row.click();
  await row.focus();
  await row.press("m");

  // After pressing "m", the ComboSelect trigger button becomes visible.
  const selectTrigger = row.getByRole("button", { name: /select/i });
  await expect(selectTrigger).toBeVisible({ timeout: 3_000 });
  await selectTrigger.click();

  // The ComboSelect dropdown is portalled into document.body.
  const comboInput = page.locator('[role="combobox"]');
  await expect(comboInput).toBeVisible({ timeout: 5_000 });

  // ── 6. Search for and pick the target record label ─────────────────────
  await comboInput.fill(targetLabel);
  const option = page.locator('[role="option"]', { hasText: targetLabel }).first();
  await expect(option).toBeVisible();
  await option.click();

  // ── 7. Assert the row now shows "Mapped" ──────────────────────────────────
  await expect(row.getByText("Mapped")).toBeVisible({ timeout: 5_000 });
  // The mapping target label should appear in the row.
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
  // Switch to "Mapped" filter and confirm our raw value now appears there.
  await page.getByRole("button", { name: "Mapped" }).click();

  const mappedSection = page.locator("section").filter({ hasText: "Country" }).first();
  await expect(mappedSection).toBeVisible({ timeout: 10_000 });

  const mappedToggle = mappedSection.locator("button").first();
  const mappedToggleText = await mappedToggle.textContent();
  if (mappedToggleText?.includes("expand")) {
    await mappedToggle.click();
  }

  const publishedRow = page.locator('[role="row"]').filter({ hasText: rawValue }).first();
  await expect(publishedRow).toBeVisible({ timeout: 10_000 });
  await expect(publishedRow.getByText("Mapped")).toBeVisible();
  await expect(publishedRow.getByText(targetLabel)).toBeVisible();
});
