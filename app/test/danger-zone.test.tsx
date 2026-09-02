import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DangerZone } from "../src/components/settings/DangerZone";

vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";
import { Danger } from "../src/routes/settings/Danger";

vi.mock("../src/api", () => ({
  apiFetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  authFetch: vi.fn().mockResolvedValue(new Response(null)),
}));
vi.mock("../src/store", async (orig) => {
  const a = await orig<typeof import("../src/store")>();
  return { ...a, initStore: vi.fn(), onTenantSwitch: vi.fn() };
});

function harness(role: "viewer" | "editor" | "admin") {
  const value: TenantContextValue = tenantFixture(role);
  return render(
    <MemoryRouter initialEntries={["/app/acme/settings/danger"]}>
      <Routes>
        <Route
          path="/app/:tenantSlug/settings/danger"
          element={
            <TenantProvider value={value}>
              <Danger />
            </TenantProvider>
          }
        />
        <Route path="/app" element={<div data-testid="redirected">redirected</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DangerZone component", () => {
  test("wraps children in a danger-toned panel", () => {
    const { container } = render(
      <DangerZone>
        <span>x</span>
      </DangerZone>,
    );
    expect((container.firstChild as HTMLElement).className).toMatch(/danger/);
  });
});

describe("Danger zone", () => {
  test("does not render Leave workspace (moved to Account/Memberships)", () => {
    harness("viewer");
    expect(screen.queryByRole("button", { name: /leave workspace/i })).toBeNull();
    expect(screen.queryByText(/leave workspace/i)).toBeNull();
  });

  test("does NOT show Delete workspace button for editor", () => {
    harness("editor");
    expect(screen.queryByRole("button", { name: /delete workspace/i })).toBeNull();
  });

  test("shows Delete workspace button for admin", () => {
    harness("admin");
    expect(screen.getByRole("button", { name: /delete workspace/i })).toBeTruthy();
  });

  test("Delete confirm requires typing the slug", () => {
    harness("admin");
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    const input = screen.getByRole("textbox");
    expect(input).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: /^delete$/i });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "acme" } });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
  });

  test("delete confirmation uses ConfirmDialog (not a bespoke modal)", () => {
    harness("admin");
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    expect(screen.getByTestId("confirm-dialog-backdrop")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
