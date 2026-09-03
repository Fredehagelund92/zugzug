/**
 * app-index-routing.test.tsx
 *
 * The membership lifecycle as the router sees it. Every routing decision must
 * read memberships live: when they change under the app (leave, delete, slug
 * rename), "/app" and TenantLayout used to disagree — TenantLayout bounced to
 * "/app", "/app" sent the user straight back into the workspace they had just
 * left, and the two <Navigate>s ping-ponged into the error boundary.
 *
 * Covers: app/src/components/BootGate.tsx (AppIndex)
 *         app/src/components/TenantLayout.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppIndex } from "../src/components/BootGate";
import { TenantLayout, type Membership } from "../src/components/TenantLayout";
import { setMemberships } from "../src/store";
import { LAST_SLUG_KEY } from "../src/lib/tenant-storage";
import { CAPABILITIES_BY_ROLE } from "./tenant-fixture";

const mockAuthFetch = vi.fn();
vi.mock("../src/api", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
  apiFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return { ...actual, initStore: vi.fn().mockResolvedValue(undefined), onTenantSwitch: vi.fn() };
});

function membership(slug: string, label = slug): Membership {
  return { slug, label, role: "admin", color: null, capabilities: CAPABILITIES_BY_ROLE.admin };
}

/** Echoes the workspace the router settled on. */
function Workspace() {
  const { tenantSlug } = useParams<{ tenantSlug: string }>();
  return <div data-testid="workspace">{tenantSlug}</div>;
}

/** The shape of main.tsx's protected route table, minus the page components. */
function harness(initialPath: string, isSuperAdmin = false) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<AppIndex isSuperAdmin={isSuperAdmin} />} />
        <Route path="/app/:tenantSlug/*" element={<TenantLayout isSuperAdmin={isSuperAdmin} />}>
          <Route path="*" element={<Workspace />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** No account has this address aliased — the plain "not a membership" case. */
function noAlias() {
  mockAuthFetch.mockImplementation((path: string) =>
    Promise.resolve(
      path.startsWith("/me/slug-alias/")
        ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
        : new Response(JSON.stringify({ email: "me@example.com" }), { status: 200 }),
    ),
  );
}

beforeEach(() => {
  mockAuthFetch.mockReset();
  localStorage.clear();
  setMemberships([]);
  noAlias();
});

describe("/app resolves against live memberships", () => {
  it("prefers the workspace last used when it is still a membership", async () => {
    setMemberships([membership("sportsbook"), membership("media")]);
    localStorage.setItem(LAST_SLUG_KEY, "media");
    harness("/app");
    expect(await screen.findByTestId("workspace")).toHaveTextContent("media");
  });

  it("falls back to the first membership when the last used one is gone", async () => {
    setMemberships([membership("sportsbook"), membership("media")]);
    localStorage.setItem(LAST_SLUG_KEY, "deleted-one");
    harness("/app");
    expect(await screen.findByTestId("workspace")).toHaveTextContent("sportsbook");
  });

  it("sends a super-admin with no memberships to the admin shell", () => {
    harness("/app", true);
    // No membership route matches "admin", so the layout renders its own child.
    expect(screen.getByTestId("workspace")).toHaveTextContent("admin");
  });

  it("shows the no-workspace landing instead of the admin shell for everyone else", () => {
    harness("/app");
    expect(screen.getByText(/not in any workspace yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).toBeNull();
  });
});

describe("memberships changing under the app", () => {
  it("leaving your only workspace lands on the no-workspace landing, not a redirect loop", async () => {
    setMemberships([membership("sportsbook")]);
    harness("/app/sportsbook/triage");
    expect(screen.getByTestId("workspace")).toHaveTextContent("sportsbook");

    // What invalidate.memberships() does after POST /t/sportsbook/leave.
    await act(async () => {
      setMemberships([]);
    });

    await waitFor(() => expect(screen.getByText(/not in any workspace yet/i)).toBeInTheDocument());
    expect(screen.queryByTestId("workspace")).toBeNull();
  });

  it("deleting the current workspace lands in a remaining one", async () => {
    setMemberships([membership("sportsbook"), membership("media")]);
    localStorage.setItem(LAST_SLUG_KEY, "sportsbook");
    harness("/app/sportsbook/settings/danger");
    expect(screen.getByTestId("workspace")).toHaveTextContent("sportsbook");

    await act(async () => {
      setMemberships([membership("media")]);
    });

    await waitFor(() => expect(screen.getByTestId("workspace")).toHaveTextContent("media"));
  });
});

describe("a workspace renamed while a member is inside it", () => {
  it("follows the rename to the new address, keeping the page", async () => {
    mockAuthFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/me/slug-alias/alpha"
          ? new Response(JSON.stringify({ slug: "beta" }), { status: 200 })
          : new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      ),
    );
    setMemberships([membership("beta", "Alpha renamed")]);
    harness("/app/alpha/triage");

    await waitFor(() => expect(screen.getByTestId("workspace")).toHaveTextContent("beta"));
    expect(mockAuthFetch).toHaveBeenCalledWith("/me/slug-alias/alpha");
  });

  it("falls back to /app when the address is not a rename of anything", async () => {
    setMemberships([membership("media")]);
    harness("/app/never-existed/triage");
    await waitFor(() => expect(screen.getByTestId("workspace")).toHaveTextContent("media"));
  });
});
