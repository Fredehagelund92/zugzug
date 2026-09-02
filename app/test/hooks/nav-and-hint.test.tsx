import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { TenantProvider } from "../../src/lib/tenant-context";
import { useTenantNavigate, useNavLinks } from "../../src/lib/use-tenant-navigate";

vi.mock("../../src/api", () => ({
  apiFetch: vi.fn(
    async () =>
      new Response(
        JSON.stringify({ suggestion: "United States", confidence: 85, reasoning: "Exact match." }),
        { status: 200 },
      ),
  ),
}));

// Spy on react-router's useNavigate so we can assert the exact target the hook
// hands to the router (keeping the rest of the module, incl. MemoryRouter, real).
const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const TENANT = {
  id: "t1",
  slug: "acme",
  label: "Acme",
  color: null,
  role: "editor" as const,
  isSuperAdmin: false,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/app/acme/tables"]}>
      <TenantProvider value={TENANT}>{children}</TenantProvider>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// useTenantNavigate
// ---------------------------------------------------------------------------
describe("useTenantNavigate", () => {
  beforeEach(() => navigateSpy.mockClear());

  test("prefixes an absolute path with the workspace slug", () => {
    const { result } = renderHook(() => useTenantNavigate(), { wrapper });
    result.current("/triage");
    expect(navigateSpy).toHaveBeenCalledWith("/app/acme/triage", undefined);
  });

  test("passes a relative path through unchanged", () => {
    const { result } = renderHook(() => useTenantNavigate(), { wrapper });
    result.current("back");
    expect(navigateSpy).toHaveBeenCalledWith("back", undefined);
  });

  test("forwards navigate options such as replace", () => {
    const { result } = renderHook(() => useTenantNavigate(), { wrapper });
    result.current("/x", { replace: true });
    expect(navigateSpy).toHaveBeenCalledWith("/app/acme/x", { replace: true });
  });
});

// ---------------------------------------------------------------------------
// useNavLinks
// ---------------------------------------------------------------------------
describe("useNavLinks", () => {
  test("all static links are prefixed with /app/acme", () => {
    const { result } = renderHook(() => useNavLinks(), { wrapper });
    const links = result.current;

    expect(links.base).toBe("/app/acme");
    expect(links.dashboard).toBe("/app/acme");
    expect(links.triage).toBe("/app/acme/triage");
    expect(links.sources).toBe("/app/acme/sources");
    expect(links.tables).toBe("/app/acme/tables");
    expect(links.audit).toBe("/app/acme/audit");
    expect(links.settings).toBe("/app/acme/settings");
    expect(links.integrations).toBe("/app/acme/settings/webhooks");
    expect(links.integrationsPullApi).toBe("/app/acme/settings/pull-api");
    expect(links.integrationsWebhooks).toBe("/app/acme/settings/webhooks");
    expect(links.integrationsServiceAccounts).toBe("/app/acme/settings/service-accounts");
  });

  test("table() generates open/active query params", () => {
    const { result } = renderHook(() => useNavLinks(), { wrapper });
    expect(result.current.table("refTable-1")).toBe(
      "/app/acme/tables?open=refTable-1&active=refTable-1",
    );
    expect(result.current.table("refTable-1", "review")).toBe(
      "/app/acme/tables?open=refTable-1&active=refTable-1&mode=review",
    );
    expect(result.current.table("refTable-1", "match")).toBe(
      "/app/acme/tables?open=refTable-1&active=refTable-1&mode=match",
    );
  });

  test("tablesFocus() encodes the key", () => {
    const { result } = renderHook(() => useNavLinks(), { wrapper });
    expect(result.current.tablesFocus("hello world")).toBe("/app/acme/tables?focus=hello%20world");
  });
});

// ---------------------------------------------------------------------------
// useAiConfigured
// ---------------------------------------------------------------------------
describe("useAiConfigured", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("reports configured when the server says an AI provider is set up", async () => {
    const { apiFetch } = await import("../../src/api");
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ configured: true }), { status: 200 }),
    );
    const { useAiConfigured } = await import("../../src/lib/use-ai-hint");

    const { result } = renderHook(() => useAiConfigured());
    await waitFor(() => expect(result.current).toBe(true), { timeout: 500 });
    expect(apiFetch).toHaveBeenCalledWith("/ai/status");
  });

  test("reports NOT configured when the deployment has no AI — so Review can hide the affordance", async () => {
    const { apiFetch } = await import("../../src/api");
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ configured: false }), { status: 200 }),
    );
    const { useAiConfigured } = await import("../../src/lib/use-ai-hint");

    const { result } = renderHook(() => useAiConfigured());
    await waitFor(() => expect(result.current).toBe(false), { timeout: 500 });
  });

  test("treats a failed status call as no AI rather than retryable", async () => {
    const { apiFetch } = await import("../../src/api");
    vi.mocked(apiFetch).mockRejectedValue(new Error("offline"));
    const { useAiConfigured } = await import("../../src/lib/use-ai-hint");

    const { result } = renderHook(() => useAiConfigured());
    await waitFor(() => expect(result.current).toBe(false), { timeout: 500 });
  });
});
