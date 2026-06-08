import { describe, test, expect, vi, beforeEach } from "vitest";
import { warehouseSyncStatusByDim } from "../src/routes/dashboard-helpers";
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

describe("warehouseSyncStatusByDim", () => {
  test("latest event per dim wins", () => {
    const audits = [
      // newest first
      { id: "1", at: "now", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse sync failed", detail: "1 → zugzug.map_country: timeout" },
      { id: "2", at: "1m", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse synced", detail: "5 → zugzug.map_partner" },
      { id: "3", at: "2m", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse synced", detail: "3 → zugzug.map_country" },
    ];
    const dims = [
      { id: "country", mapTable: "zugzug.map_country" },
      { id: "partner", mapTable: "zugzug.map_partner" },
      { id: "channel", mapTable: "zugzug.map_channel" }, // no events
    ];
    expect(warehouseSyncStatusByDim(audits, dims)).toEqual({
      country: "failed",
      partner: "synced",
      channel: "unknown",
    });
  });

  test("no warehouse events leaves all dims unknown", () => {
    const audits = [
      { id: "1", at: "now", user: { id: "u", name: "U", initials: "U" }, action: "Committed", detail: "1 value → zugzug.map_country" },
    ];
    const dims = [{ id: "country", mapTable: "zugzug.map_country" }];
    expect(warehouseSyncStatusByDim(audits, dims)).toEqual({
      country: "unknown",
    });
  });
});
