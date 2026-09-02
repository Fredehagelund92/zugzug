import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";

/* "New table" used to have no role gate at all — a viewer saw it, clicked it,
 * and POST /api/tables answered 403. Creating tables is a manage_tables
 * capability, so editors and admins keep the button and viewers don't get it. */

vi.mock("../src/store", () => ({
  useRefTables: () => [],
  useDrafts: () => ({}),
}));
vi.mock("../src/lib/open-tabs", () => ({
  useOpenTabs: () => ({ activeId: null, openTab: vi.fn() }),
}));
vi.mock("../src/lib/create-table-modal", () => ({
  useCreateTableModal: () => ({ open: vi.fn() }),
}));

import { SidebarTableTree } from "../src/components/SidebarTableTree";

function renderTree(role: "admin" | "editor" | "viewer") {
  return render(
    <MemoryRouter initialEntries={["/app/acme/tables"]}>
      <TenantProvider value={tenantFixture(role)}>
        <SidebarTableTree />
      </TenantProvider>
    </MemoryRouter>,
  );
}

describe("sidebar New table button", () => {
  it.each(["admin", "editor"] as const)("%s sees it", (role) => {
    renderTree(role);
    expect(screen.getByRole("button", { name: /new table/i })).toBeInTheDocument();
  });

  it("viewer does not", () => {
    renderTree("viewer");
    expect(screen.queryByRole("button", { name: /new table/i })).toBeNull();
  });
});
