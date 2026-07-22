import { chromium, request } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const ADMIN = { email: "e2e-admin@example.com", password: "e2e-password-123", name: "E2E Admin" };
const AUTH_PATH = "./.auth/admin.json";

async function waitForHealth(): Promise<void> {
  const ctx = await request.newContext({ baseURL: BASE });
  for (let i = 0; i < 60; i++) {
    const r = await ctx.get("/api/health").catch(() => null);
    if (r && r.ok()) {
      const body = (await r.json().catch(() => null)) as { ok?: boolean } | null;
      if (body?.ok) {
        await ctx.dispose();
        return;
      }
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  await ctx.dispose();
  throw new Error("Stack did not become healthy within 120 s");
}

export default async function globalSetup(): Promise<void> {
  await waitForHealth();

  mkdirSync("./.auth", { recursive: true });

  // Drive signup + capture session via a real browser so the zz_sid cookie is
  // stored in browser storage state (APIRequestContext cookies are not shared
  // with the browser context that test pages run in).
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();

  // Attempt signup — first user becomes admin. If the account already exists,
  // navigate to login instead.
  await page.goto("/signup");
  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: /sign up/i }).click();

  // After a successful signup the app redirects to /app (then /app/default).
  // If we land back on /signup with an error (email_taken), go log in instead.
  try {
    await page.waitForURL(/\/app/, { timeout: 15_000 });
  } catch {
    // Account already exists — use login flow.
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: /log in|sign in/i }).click();
    await page.waitForURL(/\/app/, { timeout: 15_000 });
  }

  await context.storageState({ path: AUTH_PATH });
  await browser.close();
}
