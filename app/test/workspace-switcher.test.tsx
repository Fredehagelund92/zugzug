import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { WorkspaceSwitcher } from "../src/components/WorkspaceSwitcher";

// Mock store + authFetch
vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return {
    ...actual,
    initStore: vi.fn(),
    onTenantSwitch: vi.fn(),
    useMemberships: vi.fn(() => [
      { slug: "acme", label: "Acme", role: "admin" as const, color: null },
      { slug: "globex", label: "Globex", role: "editor" as const, color: null },
    ]),
  };
});
vi.mock("../src/api", () => ({
  authFetch: vi.fn().mockResolvedValue(new Response(null)),
  apiFetch: vi.fn().mockResolvedValue(new Response(null)),
}));

function harness(isSuperAdmin: boolean, path = "/app/acme/triage") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/:tenantSlug/*"
          element={
            <TenantProvider value={{ id: "acme", slug: "acme", label: "Acme", color: null, role: "admin", isSuperAdmin }}>
              <WorkspaceSwitcher />
            </TenantProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkspaceSwitcher", () => {
  test("shows current workspace label", () => {
    harness(false);
    expect(screen.getByText("Acme")).toBeTruthy();
  });

  test("non-super-admin does NOT see Admin console", () => {
    harness(false);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.queryByText(/Admin console/i)).toBeNull();
  });

  test("super-admin sees Admin console", () => {
    harness(true);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.getByText(/Admin console/i)).toBeTruthy();
  });

  test("Sign out is always visible", () => {
    harness(false);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.getByText(/Sign out/i)).toBeTruthy();
  });

  test("shows Account for all roles (admin harness)", () => {
    harness(false);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.getByText(/^Account$/i)).toBeTruthy();
  });

  test("shows other workspaces in the list", () => {
    harness(false);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    // Globex is not the current workspace, should appear in "All workspaces"
    expect(screen.getByText("Globex")).toBeTruthy();
  });

  test("editor role does NOT see Admin console", () => {
    const value: TenantContextValue = {
      id: "acme", slug: "acme", label: "Acme", color: null, role: "editor", isSuperAdmin: false,
    };
    render(
      <MemoryRouter initialEntries={["/app/acme/triage"]}>
        <Routes>
          <Route
            path="/app/:tenantSlug/*"
            element={
              <TenantProvider value={value}>
                <WorkspaceSwitcher />
              </TenantProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.queryByText(/Admin console/i)).toBeNull();
  });
});
