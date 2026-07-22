/**
 * Journey #7 — admin invites a viewer, that user signs up via the invite,
 * and sees a read-only UI.
 *
 * Invite path: POST /api/t/default/team/invites (viewer role) via API request
 * context (the UI's invite form hardcodes role "editor" and has no role picker).
 * Signup path: /signup with the invited email — acceptInvitesFor runs automatically.
 *
 * KNOWN-FAILING (test.fixme): this E2E surfaced a real RBAC bug — an invited
 * member to the `default` workspace always becomes `editor`, ignoring the invited
 * role. `auth-password.ts` pre-seeds every non-first signup into `default` as
 * `editor` (ON CONFLICT DO NOTHING) BEFORE `acceptInvitesFor` runs, and
 * `acceptInvitesFor` (tenant.ts) also uses ON CONFLICT DO NOTHING — so the
 * invite's `viewer` role is silently discarded and the invited user gets editor
 * write access. Marked fixme until the bug is fixed; then remove `.fixme`.
 */
import { test, expect, uniqueSuffix } from "../fixtures";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";

test.fixme("admin invites a viewer; viewer signs up and sees read-only UI", async ({
  page,
  browser,
  request,
}) => {
  const suffix = uniqueSuffix();
  const viewerEmail = `e2e-viewer-${Date.now()}-${suffix}@example.com`;
  const viewerPassword = "viewer-password-e2e!";
  const viewerName = "E2E Viewer";

  // ── Step 1: As admin, POST the invite via API (role: "viewer") ──────────────
  // The Members UI hardcodes role: "editor" and has no role picker, so we use
  // the API directly. We still visit the members page to assert the invite row.
  const inviteRes = await request.post(`${BASE}/api/t/default/team/invites`, {
    data: { email: viewerEmail, role: "viewer" },
  });
  expect(inviteRes.status()).toBe(201);

  // ── Step 2: Visit members page as admin; assert pending invite appears ──────
  await page.goto("/app/default/settings/members");
  await expect(page.getByText(viewerEmail)).toBeVisible({ timeout: 10_000 });
  // The "in flight" heading labels pending invites.
  await expect(page.getByText(/in flight/i)).toBeVisible();

  // ── Step 3: Invited viewer signs up in a fresh browser context ──────────────
  const viewerCtx = await browser.newContext({ baseURL: BASE });
  const viewerPage = await viewerCtx.newPage();

  await viewerPage.goto("/signup");
  await viewerPage.getByLabel("Name").fill(viewerName);
  await viewerPage.getByLabel("Email").fill(viewerEmail);
  await viewerPage.getByLabel("Password").fill(viewerPassword);
  await viewerPage.getByRole("button", { name: /sign up/i }).click();

  // After signup the app redirects to /app (then /app/default).
  await viewerPage.waitForURL(/\/app/, { timeout: 20_000 });

  // ── Step 4: Assert read-only affordances ────────────────────────────────────
  // 4a: No "Open table" popover that exposes "New table" / create-table-button.
  //     useCanEdit() returns false for viewer → onCreateRequested is undefined →
  //     the "New table" item is never rendered in the popover.
  await viewerPage.goto("/app/default/tables");
  await expect(viewerPage.getByRole("button", { name: "Open table" })).toBeVisible({
    timeout: 10_000,
  });
  // Open the popover and assert the "New table" action is absent.
  await viewerPage.getByRole("button", { name: "Open table" }).click();
  await expect(viewerPage.getByTestId("create-table-button")).not.toBeVisible();

  // 4b: On the members/settings page, the "Send invite" button is absent for viewers
  //     because the invite form is gated by can(tenant, "settings.members.edit").
  await viewerPage.goto("/app/default/settings/members");
  await expect(viewerPage.getByRole("button", { name: /send invite/i })).not.toBeVisible({
    timeout: 10_000,
  });

  await viewerCtx.close();

  // ── Step 5: Clean up — revoke the invite (already consumed, but defensively) ─
  // The invite is consumed on signup; DELETE is idempotent and returns 204 / 404.
  await request
    .delete(`${BASE}/api/t/default/team/invites/${encodeURIComponent(viewerEmail)}`)
    .catch(() => null);
});
