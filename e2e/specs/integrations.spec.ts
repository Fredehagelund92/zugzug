/**
 * Journey #5 — service account created in UI; zzsa_ token used against pull-API.
 * Journey #6 — webhook creation + signed delivery (end-to-end).
 *
 * start.sh now auto-generates ZUGZUG_WEBHOOK_MASTER_KEY on first boot (mirroring
 * the cursor-key logic), so webhook creation succeeds in the compose stack.
 *
 * === Cross-container networking note ===
 * http://localhost:<port> webhooks route inside the container (not to the host).
 * The dispatcher signs the payload and stores the signature in the delivery row
 * BEFORE making the POST, so signature verification via the delivery-log API
 * works even when the HTTP delivery itself fails (connection refused).
 */

import { createHmac } from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, uniqueSuffix } from "../fixtures";

const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:8080";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parse the x-zugzug-signature format: t=<unix>,kid=<current|previous>,v1=sha256=<hex> */
function parseSignature(header: string): { t: number; kid: string; hex: string } | null {
  const parts: Record<string, string> = {};
  for (const seg of header.split(",")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) return null;
    parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  if (!parts["t"] || !parts["kid"] || !parts["v1"]) return null;
  const t = Number(parts["t"]);
  if (!Number.isFinite(t)) return null;
  const m = /^sha256=([0-9a-f]+)$/i.exec(parts["v1"]);
  if (!m) return null;
  return { t, kid: parts["kid"], hex: m[1]! };
}

/** Verify HMAC-SHA256 against the stored signature. */
function verifySignature(rawBody: string, secret: string, t: number, expectedHex: string): boolean {
  const computed = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return computed === expectedHex;
}

// ── Journey #5: service account + pull-API ───────────────────────────────────

test("create service account and call pull-API with zzsa_ token", async ({ page, request }) => {
  const saName = `E2E SA ${uniqueSuffix()}`;

  // Navigate to the service-accounts settings page.
  await page.goto("/app/default/settings/service-accounts");
  await expect(page.getByRole("heading", { name: "Service accounts", exact: true })).toBeVisible();

  // Open the create form. Text varies depending on whether accounts already exist.
  const newBtn = page.getByRole("button", { name: /new service account|create one/i }).first();
  await expect(newBtn).toBeVisible();
  await newBtn.click();

  // Fill in the name.
  const nameInput = page.getByPlaceholder("dbt prod");
  await expect(nameInput).toBeVisible();
  await nameInput.fill(saName);

  // Submit.
  await page.getByRole("button", { name: "Create" }).click();

  // The SecretRevealModal opens with the zzsa_ token.
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole("heading", { name: "Copy your service account token", exact: true }),
  ).toBeVisible();

  // The token is in a <code> element inside the modal.
  const tokenEl = modal.locator("code");
  await expect(tokenEl).toBeVisible();
  const zzsa = await tokenEl.textContent();
  expect(zzsa).toBeTruthy();
  expect(zzsa!.trim()).toMatch(/^zzsa_/);
  const token = zzsa!.trim();

  // Must click "Copy" before the dismiss button is enabled.
  await modal.getByRole("button", { name: "Copy" }).click();
  await modal.getByRole("button", { name: /i've copied it/i }).click();
  await expect(modal).not.toBeVisible();

  // ── Pull-API: authenticated call ────────────────────────────────────────────
  // GET /api/t/default/v1/tables — lists dimensions for the workspace.
  const authedRes = await request.get("/api/t/default/v1/tables", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(authedRes.status()).toBe(200);
  const body = (await authedRes.json()) as { tables?: unknown[] };
  // The seeded workspace has at least one table (Country, Product Category, etc.)
  expect(Array.isArray(body.tables)).toBe(true);
  expect((body.tables as unknown[]).length).toBeGreaterThan(0);

  // ── Pull-API: no credentials must be rejected ───────────────────────────────
  // Create a fresh context with no cookies/auth to test the unauthenticated path.
  // The test fixture's `request` shares the admin session cookies, so a separate
  // context is needed here.
  // Explicit empty storageState: without this, playwrightRequest.newContext inherits
  // the project-level storageState (admin session cookies) from playwright.config.ts.
  const noAuthCtx = await playwrightRequest.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const unauthRes = await noAuthCtx.get("/api/t/default/v1/tables");
    expect(unauthRes.status()).toBe(401);

    // ── Pull-API: bad token must be rejected ──────────────────────────────────
    const badTokenRes = await noAuthCtx.get("/api/t/default/v1/tables", {
      headers: { authorization: "Bearer zzsa_thisisnotavalidtoken1234" },
    });
    expect(badTokenRes.status()).toBe(401);
  } finally {
    await noAuthCtx.dispose();
  }
});

// ── Journey #6: webhook creation + signed delivery ───────────────────────────

test("create webhook and verify signed delivery", async ({ page, request }) => {
  // The webhook dispatcher runs on a 60 s scheduler tick; give the whole test
  // enough headroom to cover one full tick cycle plus UI interaction time.
  test.setTimeout(120_000);
  // Part A: Verify the HMAC-SHA256 signing algorithm contract independently.
  // Format: HMAC_SHA256(secret, "<unix>.<rawBody>"), encoded as t=…,kid=…,v1=sha256=…
  const algoSecret = "whsec_testSecretForAlgorithmVerification";
  const algoBody = JSON.stringify({ event: "table.published", table: "country", kind: "publish" });
  const algoT = Math.floor(Date.now() / 1000);
  const algoHex = createHmac("sha256", algoSecret).update(`${algoT}.${algoBody}`).digest("hex");
  const algoHeader = `t=${algoT},kid=current,v1=sha256=${algoHex}`;

  const algoParsed = parseSignature(algoHeader);
  expect(algoParsed).not.toBeNull();
  expect(algoParsed!.kid).toBe("current");
  expect(algoParsed!.t).toBe(algoT);
  expect(verifySignature(algoBody, algoSecret, algoParsed!.t, algoParsed!.hex)).toBe(true);
  expect(verifySignature(algoBody + "!", algoSecret, algoParsed!.t, algoParsed!.hex)).toBe(false);
  expect(verifySignature(algoBody, "wrong_secret", algoParsed!.t, algoParsed!.hex)).toBe(false);

  // Part B: Create a webhook via the UI and capture the signing secret.
  await page.goto("/app/default/settings/webhooks");

  const createBtn = page
    .getByRole("button", { name: /create your first webhook|new webhook/i })
    .first();
  await expect(createBtn).toBeVisible();
  await createBtn.click();

  const createModal = page.getByRole("dialog");
  await expect(
    createModal.getByRole("heading", { name: "New webhook", exact: true }),
  ).toBeVisible();
  await expect(createModal.getByPlaceholder(/https:\/\/api\.acme\.com/i)).toBeVisible();

  // Use http://localhost — allowed by self-hosted URL policy, but the port won't
  // be open inside the container. The dispatcher still signs + stores the signature
  // before the POST attempt, so delivery-log verification works even on a failed POST.
  await createModal
    .getByPlaceholder(/https:\/\/api\.acme\.com/i)
    .fill("http://localhost:19876/e2e-hook");

  await createModal.getByRole("button", { name: "Create webhook" }).click();

  // After successful creation the "New webhook" heading disappears and the
  // SecretRevealModal opens. Wait for the reveal heading directly.
  const revealModal = page.getByRole("dialog");
  await expect(
    revealModal.getByRole("heading", { name: "Copy your signing secret", exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const secretEl = revealModal.locator("code");
  await expect(secretEl).toBeVisible();
  const signingSecret = (await secretEl.textContent())?.trim() ?? "";
  expect(signingSecret).toMatch(/^whsec_/);

  // Copy and dismiss.
  await revealModal.getByRole("button", { name: "Copy" }).click();
  await revealModal.getByRole("button", { name: /i've copied it/i }).click();
  await expect(revealModal).not.toBeVisible();

  // Part C: Find the newly created webhook ID via the API.
  const listRes = await request.get("/api/t/default/v1/webhooks");
  expect(listRes.status()).toBe(200);
  const { webhooks } = (await listRes.json()) as { webhooks: Array<{ id: string; url: string }> };
  const hook = webhooks.find((w) => w.url.includes("19876"));
  expect(hook).toBeDefined();
  const webhookId = hook!.id;

  // Part D: Trigger a test delivery.
  const testRes = await request.post(`/api/t/default/v1/webhooks/${webhookId}/test`);
  expect(testRes.status()).toBe(200);
  const { delivery_id } = (await testRes.json()) as { delivery_id: string };
  expect(delivery_id).toMatch(/^whd_/);

  // Part E: Poll the delivery log until the dispatcher signs + attempts the delivery.
  // The scheduler tick interval is 60 s in production; give it up to 90 s.
  let delivery: {
    status: string;
    signature: string | null;
    payload: unknown;
  } | null = null;

  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(500);
    const dr = await request.get(`/api/t/default/v1/webhook-deliveries/${delivery_id}`);
    if (dr.status() !== 200) continue;
    const d = (await dr.json()) as typeof delivery;
    if (d && d.status !== "pending" && d.status !== "in_flight" && d.signature) {
      delivery = d;
      break;
    }
  }

  expect(delivery).not.toBeNull();
  expect(delivery!.signature).toBeTruthy();

  // Part F: Verify the stored signature against the signing secret.
  const parsed = parseSignature(delivery!.signature!);
  expect(parsed).not.toBeNull();
  expect(parsed!.kid).toBe("current");

  const rawBody =
    typeof delivery!.payload === "string"
      ? delivery!.payload
      : JSON.stringify(delivery!.payload);

  const verified = verifySignature(rawBody, signingSecret, parsed!.t, parsed!.hex);
  expect(verified).toBe(true);
});
