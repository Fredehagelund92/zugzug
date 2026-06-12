import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TenantProvider } from "../src/lib/tenant-context";
import { WorkspaceSwitcher } from "../src/components/WorkspaceSwitcher";

// Mock store + authFetch
vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return { ...actual, initStore: vi.fn(), onTenantSwitch: vi.fn() };
});
vi.mock("../src/api", () => ({
  authFetch: vi.fn().mockResolvedValue(new Response(null)),
  apiFetch: vi.fn().mockResolvedValue(new Response(null)),
}));

const memberships = [
  { slug: "acme", label: "Acme", role: "admin" as const },
  { slug: "globex", label: "Globex", role: "editor" as const },
];

function harness(isSuperAdmin: boolean, path = "/app/acme/triage") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/:tenantSlug/*"
          element={
            <TenantProvider value={{ id: "acme", slug: "acme", label: "Acme", role: "admin", isSuperAdmin }}>
              <WorkspaceSwitcher memberships={memberships} />
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

  test("non-super-admin does NOT see Create workspace or Admin console", () => {
    harness(false);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.queryByText(/Create workspace/i)).toBeNull();
    expect(screen.queryByText(/Admin console/i)).toBeNull();
  });

  test("super-admin sees Create workspace and Admin console", () => {
    harness(true);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.getByText(/\+ Create workspace/i)).toBeTruthy();
    expect(screen.getByText(/Admin console/i)).toBeTruthy();
  });

  test("Sign out is always visible", () => {
    harness(false);
    fireEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.getByText(/Sign out/i)).toBeTruthy();
  });
});
