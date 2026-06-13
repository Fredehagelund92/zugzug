import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TenantProvider, useTenant } from "../src/lib/tenant-context";
import { TenantLayout } from "../src/components/TenantLayout";
import { setMemberships } from "../src/store";

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return {
    ...actual,
    initStore: vi.fn().mockResolvedValue(undefined),
    onTenantSwitch: vi.fn(),
  };
});

function Probe() {
  const t = useTenant();
  return <div data-testid="ctx">{t.slug}/{t.role}</div>;
}

// Minimal error boundary to catch render-time throws from hooks
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) throw this.state.error;
    return this.props.children;
  }
}

const fakeMemberships = [{ slug: "acme", label: "Acme", role: "admin" as const }];

describe("TenantLayout slug validation", () => {
  test("renders children when slug is in memberships", () => {
    setMemberships(fakeMemberships);
    render(
      <MemoryRouter initialEntries={["/app/acme/triage"]}>
        <Routes>
          <Route element={<TenantLayout memberships={fakeMemberships} isSuperAdmin={false} />}>
            <Route path="/app/:tenantSlug/triage" element={<div data-testid="kid">child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("kid")).toBeTruthy();
  });

  test("redirects to /app when slug is not in memberships and not super-admin", async () => {
    setMemberships(fakeMemberships);
    render(
      <MemoryRouter initialEntries={["/app/forbidden/triage"]}>
        <Routes>
          <Route element={<TenantLayout memberships={fakeMemberships} isSuperAdmin={false} />}>
            <Route path="/app/:tenantSlug/triage" element={<div data-testid="kid">child</div>} />
          </Route>
          <Route path="/app" element={<div data-testid="redirected">redirected</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("kid")).toBeNull();
    expect(screen.getByTestId("redirected")).toBeTruthy();
  });

  test("super-admin can enter a tenant they're not a member of", () => {
    setMemberships(fakeMemberships);
    render(
      <MemoryRouter initialEntries={["/app/other/triage"]}>
        <Routes>
          <Route element={<TenantLayout memberships={fakeMemberships} isSuperAdmin={true} />}>
            <Route path="/app/:tenantSlug/triage" element={<div data-testid="kid">child</div>} />
          </Route>
          <Route path="/app" element={<div data-testid="redirected">redirected</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("kid")).toBeTruthy();
    expect(screen.queryByTestId("redirected")).toBeNull();
  });
});

describe("TenantProvider", () => {
  test("exposes tenant via useTenant()", () => {
    render(
      <TenantProvider value={{ id: "t1", slug: "acme", label: "Acme", role: "admin", isSuperAdmin: false }}>
        <Probe />
      </TenantProvider>,
    );
    expect(screen.getByTestId("ctx").textContent).toBe("acme/admin");
  });

  test("throws when used outside provider", () => {
    expect(() =>
      render(
        <ErrorBoundary>
          <Probe />
        </ErrorBoundary>,
      ),
    ).toThrow(/useTenant.*outside/);
  });
});
