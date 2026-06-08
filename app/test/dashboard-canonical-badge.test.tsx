import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const stubDim = {
  id: "d1",
  dimension: "Country",
  mapTable: "map_country",
  rows: 100,
  color: null,
  canonical: [],
  values: [],
};

describe("Dashboard canonical-destination badge", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("renders 'Local + export' when workspace is read-only", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          canonicalMode: "postgres-export",
          warehouseDb: "analytics",
        }),
        useDimensions: () => [stubDim],
        useAudit: () => [],
        useDrafts: () => ({}),
      };
    });
    const { Dashboard } = await import("../src/routes/Dashboard");
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Local \+ export/i)).toBeInTheDocument();
    });
  });

  test("renders 'Snowflake — writable' when workspace is writable", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "snowflake",
          writable: true,
          canonicalMode: "warehouse",
          warehouseDb: "ANALYTICS",
        }),
        useDimensions: () => [stubDim],
        useAudit: () => [],
        useDrafts: () => ({}),
      };
    });
    const { Dashboard } = await import("../src/routes/Dashboard");
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Snowflake.*writable/i)).toBeInTheDocument();
    });
  });
});
