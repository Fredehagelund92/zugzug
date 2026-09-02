import { describe, test, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 15000 });
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VersionHistory } from "../src/components/VersionHistory";
import { TenantProvider } from "../src/lib/tenant-context";
import type { TenantContextValue } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";
import type { VersionInfo } from "../src/store";

vi.mock("../src/store", () => ({
  fetchVersions: vi.fn(),
  rollbackDim: vi.fn(),
}));

import { fetchVersions, rollbackDim } from "../src/store";

const versions: VersionInfo[] = [
  {
    version: 3,
    kind: "publish",
    restoresVersion: null,
    publishedBy: "u1",
    publishedByName: "Alice",
    at: new Date(Date.now() - 60_000).toISOString(),
    counts: { records: 10, mappings: 20 },
    hasSnapshot: true,
  },
  {
    version: 2,
    kind: "rollback",
    restoresVersion: 1,
    publishedBy: "u2",
    publishedByName: "Bob",
    at: new Date(Date.now() - 3_600_000).toISOString(),
    counts: { records: 8, mappings: 15 },
    hasSnapshot: true,
  },
  {
    version: 1,
    kind: "publish",
    restoresVersion: null,
    publishedBy: "u1",
    publishedByName: "Alice",
    at: new Date(Date.now() - 86_400_000).toISOString(),
    counts: { records: 5, mappings: 10 },
    hasSnapshot: true,
  },
];

function makeTenant(role: "admin" | "editor" | "viewer"): TenantContextValue {
  return tenantFixture(role);
}

function renderHistory(
  role: "admin" | "editor" | "viewer" = "admin",
  overrides: Partial<{
    onClose: () => void;
    onRollbackSuccess: () => void;
    flash: () => void;
  }> = {},
) {
  const props = {
    refTableId: "country",
    onClose: vi.fn(),
    onRollbackSuccess: vi.fn(),
    flash: vi.fn(),
    ...overrides,
  };
  return {
    ...render(
      <TenantProvider value={makeTenant(role)}>
        <VersionHistory {...props} />
      </TenantProvider>,
    ),
    props,
  };
}

beforeEach(() => {
  vi.mocked(fetchVersions).mockResolvedValue(versions);
  vi.mocked(rollbackDim).mockResolvedValue(undefined);
});

describe("VersionHistory", () => {
  test("renders versions newest-first with labels", async () => {
    renderHistory("admin");
    await waitFor(() => expect(screen.getByText("v3")).toBeInTheDocument());
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();

    // v2 is a rollback restoring v1
    expect(screen.getByText("restores v1")).toBeInTheDocument();
    // v1 and v3 are plain publishes
    const publishLabels = screen.getAllByText("publish");
    expect(publishLabels.length).toBeGreaterThanOrEqual(2);

    // authors
    expect(screen.getAllByText("Alice").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Bob")).toBeInTheDocument();

    // counts
    expect(screen.getByText(/10 records \/ 20 mappings/)).toBeInTheDocument();
    expect(screen.getByText(/8 records \/ 15 mappings/)).toBeInTheDocument();
    expect(screen.getByText(/5 records \/ 10 mappings/)).toBeInTheDocument();
  });

  test("admin sees rollback buttons on every version except the newest", async () => {
    renderHistory("admin");
    await waitFor(() => expect(screen.getByText("v3")).toBeInTheDocument());

    // v2 and v1 should have rollback buttons; v3 (newest) should not
    expect(screen.getByRole("button", { name: /roll back to v2/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /roll back to v1/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /roll back to v3/i })).toBeNull();
  });

  test("editor sees no rollback buttons", async () => {
    renderHistory("editor");
    await waitFor(() => expect(screen.getByText("v3")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /roll back to/i })).toBeNull();
  });

  test("viewer sees no rollback buttons", async () => {
    renderHistory("viewer");
    await waitFor(() => expect(screen.getByText("v3")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /roll back to/i })).toBeNull();
  });

  test("clicking rollback opens ConfirmDialog with correct title", async () => {
    renderHistory("admin");
    await waitFor(() => expect(screen.getByText("v3")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /roll back to v2/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/roll back to v2\?/i)).toBeInTheDocument();
  });

  test("shows footer note about pre-history versions", async () => {
    renderHistory("admin");
    await waitFor(() => expect(screen.getByText("v3")).toBeInTheDocument());
    expect(
      screen.getByText(/versions published before version history existed can't be rolled back/i),
    ).toBeInTheDocument();
  });
});
