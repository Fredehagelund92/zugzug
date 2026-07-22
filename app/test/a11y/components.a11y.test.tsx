/**
 * Accessibility checks via vitest-axe (wraps axe-core).
 * Each test renders a component and asserts no axe violations.
 * Trivial violations are fixed at the source; non-trivial ones are
 * documented in .superpowers/sdd/task-1-report.md.
 */
import { describe, test, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";
import { Login } from "../../src/routes/Login";
import { Signup } from "../../src/routes/Signup";
import { General } from "../../src/routes/settings/General";
import { Dashboard } from "../../src/routes/Dashboard";
import { TenantProvider, type TenantContextValue } from "../../src/lib/tenant-context";
import { DataGrid } from "../../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../../src/components/datagrid/types";

// ── top-level mocks (hoisted by vitest) ──────────────────────────────────────

vi.mock("../../src/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
  authFetch: vi.fn().mockResolvedValue({ ok: false, status: 0 }),
  fetchWarehouseHealth: vi.fn().mockResolvedValue({ ok: true }),
  fetchWarehouseDatabases: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/store", () => ({
  useAuthConfig: () => ({ mode: "password", allowedDomain: null }),
  useDimensions: () => [],
  useAudit: () => [],
  useWorkspaceInfo: () => ({ writable: true }),
  useStoreLoading: () => false,
  useSources: () => [],
  invalidate: { tenant: vi.fn(), memberships: vi.fn() },
}));

vi.mock("../../src/lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({
    tables: "/app/acme/tables",
    sources: "/app/acme/sources",
    triage: "/app/acme/triage",
    table: (id: string) => `/app/acme/tables/${id}`,
  }),
}));

// ── shared helpers ───────────────────────────────────────────────────────────

const tenant: TenantContextValue = {
  id: "t1",
  slug: "acme",
  label: "Acme",
  role: "admin",
  isSuperAdmin: false,
};

function withAll(ui: React.ReactNode, route = "/") {
  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[route]}>
        <TenantProvider value={tenant}>{children}</TenantProvider>
      </MemoryRouter>
    ),
  });
}

function withRouter(ui: React.ReactNode) {
  return render(ui, {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
}

// ── Login ────────────────────────────────────────────────────────────────────

describe("a11y: Login", () => {
  test("no axe violations (password mode)", async () => {
    const { container } = withRouter(<Login />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ── Signup ───────────────────────────────────────────────────────────────────

describe("a11y: Signup", () => {
  test("no axe violations", async () => {
    const { container } = withRouter(<Signup />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ── Settings/General ─────────────────────────────────────────────────────────

describe("a11y: Settings/General", () => {
  test("no axe violations (admin role)", async () => {
    const { container } = withAll(<General />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ── Dashboard (empty-workspace state) ────────────────────────────────────────

describe("a11y: Dashboard (empty workspace)", () => {
  test("no axe violations", async () => {
    const { container } = withAll(<Dashboard />, "/app/acme");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ── DataGrid ─────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
}

const gridRows: Row[] = [
  { id: "r1", name: "Alpha" },
  { id: "r2", name: "Bravo" },
];

const gridColumns: ColumnDef<Row>[] = [
  { field: "name", label: "Name", config: { type: "text" }, editable: true },
];

describe("a11y: DataGrid", () => {
  test("no axe violations on a rendered grid", async () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={gridRows}
          columns={gridColumns}
          rowKey={(r) => r.id}
          onCommit={async () => {}}
        />
      </UndoStackProvider>,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
