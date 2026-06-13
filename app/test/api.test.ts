import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Helper to set window.location.pathname for URL derivation tests.
// jsdom allows reassigning location properties via Object.defineProperty.
function setPathname(pathname: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, pathname },
    writable: true,
    configurable: true,
  });
}

describe("apiFetch — URL derivation", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response()) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("regular tenant slug: /app/acme/tables + /dimensions → /api/t/acme/dimensions", async () => {
    setPathname("/app/acme/tables");
    const { apiFetch } = await import("../src/api");
    await apiFetch("/dimensions");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/t/acme/dimensions",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("tenant slug with query string: /app/globex/triage + /audit?limit=30 → /api/t/globex/audit?limit=30", async () => {
    setPathname("/app/globex/triage");
    const { apiFetch } = await import("../src/api");
    await apiFetch("/audit?limit=30");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/t/globex/audit?limit=30",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("slug=admin at deep path: /app/admin/tenants + /tenants → /api/admin/tenants", async () => {
    setPathname("/app/admin/tenants");
    const { apiFetch } = await import("../src/api");
    await apiFetch("/tenants");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/admin/tenants",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("slug=admin, no trailing path segment: /app/admin + /audit → /api/admin/audit (trailing-slash trick)", async () => {
    setPathname("/app/admin");
    const { apiFetch } = await import("../src/api");
    await apiFetch("/audit");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/admin/audit",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("no slug (pre-login): /login + /auth/me → /api/auth/me", async () => {
    setPathname("/login");
    const { apiFetch } = await import("../src/api");
    await apiFetch("/auth/me");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("explicit /admin/ prefix overrides slug: /app/acme/tables + /admin/audit → /api/admin/audit", async () => {
    setPathname("/app/acme/tables");
    const { apiFetch } = await import("../src/api");
    await apiFetch("/admin/audit");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/admin/audit",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("authFetch — always /api<path>", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response()) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("authFetch ignores slug and always prefixes /api", async () => {
    setPathname("/app/acme/tables");
    const { authFetch } = await import("../src/api");
    await authFetch("/auth/me");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("authFetch works from pre-login path", async () => {
    setPathname("/login");
    const { authFetch } = await import("../src/api");
    await authFetch("/auth/login");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("authFetch /me/memberships is never tenant-prefixed", async () => {
    setPathname("/app/globex/triage");
    const { authFetch } = await import("../src/api");
    await authFetch("/me/memberships");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/me/memberships",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
