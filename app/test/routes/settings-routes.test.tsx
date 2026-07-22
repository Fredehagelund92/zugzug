/**
 * settings-routes.test.tsx
 *
 * Component tests for untested branches of:
 *   - app/src/routes/settings/Danger.tsx
 *   - app/src/routes/settings/General.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../../src/lib/tenant-context";
import { Danger } from "../../src/routes/settings/Danger";
import { General } from "../../src/routes/settings/General";
import { clearToasts } from "../../src/components/Toast";
import { ToastStack } from "../../src/components/Toast";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockApiFetch = vi.fn();
vi.mock("../../src/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockInvalidateMemberships = vi.fn().mockResolvedValue(undefined);
const mockInvalidateTenantList = vi.fn();
const mockInvalidateTenant = vi.fn().mockResolvedValue(undefined);
const mockGetMemberships = vi.fn();

vi.mock("../../src/store", async (orig) => {
  const a = await orig<typeof import("../../src/store")>();
  return {
    ...a,
    initStore: vi.fn(),
    onTenantSwitch: vi.fn(),
    getMemberships: (...args: unknown[]) => mockGetMemberships(...args),
    invalidate: {
      ...a.invalidate,
      memberships: (...args: unknown[]) => mockInvalidateMemberships(...args),
      tenantList: (...args: unknown[]) => mockInvalidateTenantList(...args),
      tenant: (...args: unknown[]) => mockInvalidateTenant(...args),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenant(overrides: Partial<TenantContextValue> = {}): TenantContextValue {
  return {
    id: "t1",
    slug: "acme",
    label: "Acme",
    color: null,
    role: "admin",
    isSuperAdmin: false,
    ...overrides,
  };
}

/** A probe component that exposes the current router location for assertions. */
function LocationProbe({ id }: { id: string }) {
  const loc = useLocation();
  return <div data-testid={id} data-pathname={loc.pathname} />;
}

/** Render Danger inside a MemoryRouter with a location probe route. */
function renderDanger(tenant: TenantContextValue) {
  return render(
    <>
      <MemoryRouter initialEntries={[`/app/${tenant.slug}/settings/danger`]}>
        <Routes>
          <Route
            path="/app/:tenantSlug/settings/danger"
            element={
              <TenantProvider value={tenant}>
                <Danger />
              </TenantProvider>
            }
          />
          <Route path="*" element={<LocationProbe id="location-probe" />} />
        </Routes>
      </MemoryRouter>
      {/* Render ToastStack outside MemoryRouter so portals render in the test document */}
      <ToastStack />
    </>,
  );
}

/** Render General inside a MemoryRouter with a location probe. */
function renderGeneral(tenant: TenantContextValue) {
  return render(
    <MemoryRouter initialEntries={[`/app/${tenant.slug}/settings/general`]}>
      <Routes>
        <Route
          path="/app/:tenantSlug/settings/general"
          element={
            <TenantProvider value={tenant}>
              <General />
            </TenantProvider>
          }
        />
        <Route path="*" element={<LocationProbe id="location-probe" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
});

afterEach(() => {
  clearToasts();
});

// ---------------------------------------------------------------------------
// Danger.tsx branches
// ---------------------------------------------------------------------------

describe("Danger — delete workspace", () => {
  it("'default' workspace shows a disabled Delete workspace button", () => {
    const tenant = makeTenant({ slug: "default", label: "Default" });
    renderDanger(tenant);
    const btn = screen.getByRole("button", { name: /delete workspace/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("admin + correct slug phrase → DELETE fires (204) → invalidate.memberships() called → navigates away", async () => {
    // Pre-populate memberships so Danger.tsx picks the next workspace
    mockGetMemberships.mockReturnValue([
      { slug: "acme", label: "Acme", role: "admin" },
      { slug: "other", label: "Other", role: "editor" },
    ]);
    mockApiFetch.mockResolvedValue(new Response(null, { status: 204 }));

    renderDanger(makeTenant());

    // Open confirm dialog
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));

    // Type the slug phrase to satisfy the phrase gate
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "acme" } });

    // Click the confirm Delete button
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("", expect.objectContaining({ method: "DELETE" }));
    });
    await waitFor(() => {
      expect(mockInvalidateMemberships).toHaveBeenCalled();
    });
    // Should have navigated away from the danger page (to /app/other)
    await waitFor(() => {
      const probe = screen.getByTestId("location-probe");
      expect(probe.dataset.pathname).toBe("/app/other");
    });
  });

  it("DELETE → 500 → error toast renders; no navigation", async () => {
    mockGetMemberships.mockReturnValue([{ slug: "acme", label: "Acme", role: "admin" }]);
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "internal error" }), { status: 500 }),
    );

    renderDanger(makeTenant());

    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "acme" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    // The ToastStack renders with role="status"; await the error message
    await waitFor(() => {
      const status = document.body.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status?.textContent).toMatch(/couldn't delete workspace/i);
    });

    // No navigation — still on the danger page
    expect(screen.queryByTestId("location-probe")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// General.tsx branches
// ---------------------------------------------------------------------------

describe("General — role gating", () => {
  it("viewer role → workspace name fieldset is disabled (ReadOnly wrapper)", () => {
    const tenant = makeTenant({ role: "viewer" });
    renderGeneral(tenant);
    const input = screen.getByDisplayValue("Acme");
    // jsdom does not propagate fieldset[disabled] to inputs, but the fieldset itself is disabled
    const fieldset = input.closest("fieldset") as HTMLFieldSetElement;
    expect(fieldset).not.toBeNull();
    expect(fieldset.disabled).toBe(true);
  });
});

describe("General — slug editor (super-admin)", () => {
  it("slug editor is NOT shown to a non-super-admin", () => {
    renderGeneral(makeTenant({ isSuperAdmin: false }));
    // The slug Save button is only present for super-admins
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
  });

  it("super-admin → slug editor is visible", () => {
    renderGeneral(makeTenant({ isSuperAdmin: true }));
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
  });

  it("super-admin saving a new slug (PATCH 200) → PATCH fires and memberships refresh", async () => {
    mockApiFetch.mockResolvedValue(new Response(null, { status: 200 }));
    mockInvalidateMemberships.mockResolvedValue(undefined);

    renderGeneral(makeTenant({ isSuperAdmin: true }));

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    // The slug input is the <input> sibling of the Save button in the same flex div
    const slugInput = saveBtn.closest("div")!.querySelector("input") as HTMLInputElement;
    expect(slugInput).not.toBeNull();

    fireEvent.change(slugInput, { target: { value: "acme-new" } });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify the PATCH fired with the new slug
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/slug",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ slug: "acme-new" }),
        }),
      );
    });

    // Verify memberships were refreshed (prerequisite before navigate())
    await waitFor(() => {
      expect(mockInvalidateMemberships).toHaveBeenCalled();
    });
  });

  it("super-admin PATCH fails → inline error (role='status') appears; no navigation", async () => {
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "slug already taken" }), { status: 422 }),
    );

    renderGeneral(makeTenant({ isSuperAdmin: true }));

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    const slugInput = saveBtn.closest("div")!.querySelector("input") as HTMLInputElement;

    fireEvent.change(slugInput, { target: { value: "taken-slug" } });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Inline slugError renders with role="status"
    await waitFor(() => {
      const err = screen.getByRole("status");
      expect(err.textContent).toMatch(/slug already taken/i);
    });

    // No navigation
    expect(screen.queryByTestId("location-probe")).toBeNull();
  });
});
