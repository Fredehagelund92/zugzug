import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { Warehouse } from "../src/routes/settings/Warehouse";

vi.mock("../src/store", () => ({
  useWorkspaceInfo: () => ({ adapter: "motherduck", warehouseDb: "md:demo", writable: true }),
  useDimensions: () => [],
  useAudit: () => [],
  useConnectionHealth: () => ({
    warehouse: { status: "ok", lastCheckedAt: new Date().toISOString() },
    postgres: { status: "ok", lastCheckedAt: new Date().toISOString() },
  }),
  refreshConnectionHealth: vi.fn(async () => undefined),
  usePreferences: () => ({ scanSchedule: null, publishThreshold: 0.9, suggestThreshold: 0.6 }),
  setPreferences: vi.fn(),
  scanSources: vi.fn(async () => 0),
  listApiTokens: vi.fn(async () => []),
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
}));
vi.mock("../src/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock("../src/lib/engineer-mode", () => ({ useEngineerMode: () => ({ engineer: false }) }));

function harness(role: "viewer" | "editor" | "admin") {
  const value: TenantContextValue = {
    id: "t1",
    slug: "acme",
    label: "Acme",
    role,
    isSuperAdmin: false,
  };
  return render(
    <MemoryRouter>
      <TenantProvider value={value}>
        <Warehouse />
      </TenantProvider>
    </MemoryRouter>,
  );
}

describe("Warehouse page (folded sections)", () => {
  test("admin sees Connections + Scans + Tokens sections", () => {
    harness("admin");
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Scans")).toBeInTheDocument();
    expect(screen.getByText("API tokens")).toBeInTheDocument();
  });

  test("editor sees Connections + Scans + Tokens", () => {
    harness("editor");
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Scans")).toBeInTheDocument();
    expect(screen.getByText("API tokens")).toBeInTheDocument();
  });

  test("viewer sees Connections + Scans but NOT Tokens", () => {
    harness("viewer");
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Scans")).toBeInTheDocument();
    expect(screen.queryByText("API tokens")).toBeNull();
  });
});
