import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { SettingsSidebar } from "../src/components/settings/SettingsSidebar";

function harness(role: "viewer" | "editor" | "admin", path = "/app/acme/settings/general") {
  const value: TenantContextValue = {
    id: "t1",
    slug: "acme",
    label: "Acme",
    role,
    isSuperAdmin: false,
  };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TenantProvider value={value}>
        <SettingsSidebar />
      </TenantProvider>
    </MemoryRouter>,
  );
}

describe("SettingsSidebar", () => {
  test("viewer does NOT see Tokens", () => {
    harness("viewer");
    expect(screen.queryByText(/^general$/i)).toBeTruthy();
    expect(screen.queryByText(/^members$/i)).toBeTruthy();
    expect(screen.queryByText(/^tokens$/i)).toBeNull();
  });

  test("editor sees Tokens", () => {
    harness("editor");
    expect(screen.queryByText(/^tokens$/i)).toBeTruthy();
  });

  test("admin sees every section", () => {
    harness("admin");
    for (const label of ["General", "Members", "Tokens", "Scans", "Matching", "Warehouse", "Appearance", "Audit", "Danger"]) {
      expect(screen.queryByText(new RegExp(`^${label}$`, "i"))).toBeTruthy();
    }
  });

  test("active route gets aria-current", () => {
    harness("admin", "/app/acme/settings/members");
    const active = screen.getByText(/^members$/i).closest("a");
    expect(active?.getAttribute("aria-current")).toBe("page");
  });
});
