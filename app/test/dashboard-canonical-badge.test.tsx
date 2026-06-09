import { describe, test, expect, vi, beforeEach } from "vitest";
import { warehouseSyncStatusByDim } from "../src/routes/dashboard-helpers";
import { render, screen, waitFor } from "@testing-library/react";

const stubDim = {
  id: "country",
  dimension: "Country",
  mapTable: "zugzug.map_country",
  rows: 100,
  color: null,
  canonical: [],
  values: [],
};

describe("CanonicalDestinationChip", () => {
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
      };
    });
    const { CanonicalDestinationChip } = await import(
      "../src/components/CanonicalDestinationChip"
    );
    render(<CanonicalDestinationChip />);
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
      };
    });
    const { CanonicalDestinationChip } = await import(
      "../src/components/CanonicalDestinationChip"
    );
    render(<CanonicalDestinationChip />);
    await waitFor(() => {
      expect(screen.getByText(/Snowflake.*writable/i)).toBeInTheDocument();
    });
  });

  test("renders sync rollup when writable mode has failed dim(s)", async () => {
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
        useAudit: () => [
          {
            id: "1",
            at: "now",
            user: { id: "u", name: "U", initials: "U" },
            action: "Warehouse sync failed",
            detail: "1 → zugzug.map_country: timeout",
          },
        ],
      };
    });
    const { CanonicalDestinationChip } = await import(
      "../src/components/CanonicalDestinationChip"
    );
    render(<CanonicalDestinationChip />);
    await waitFor(() => {
      expect(screen.getByText(/1 needs resync/i)).toBeInTheDocument();
    });
  });

  test("does not render sync rollup in read-only mode (postgres-export)", async () => {
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
        useAudit: () => [
          {
            id: "1",
            at: "now",
            user: { id: "u", name: "U", initials: "U" },
            action: "Warehouse sync failed",
            detail: "1 → zugzug.map_country: timeout",
          },
        ],
      };
    });
    const { CanonicalDestinationChip } = await import(
      "../src/components/CanonicalDestinationChip"
    );
    render(<CanonicalDestinationChip />);
    await waitFor(() => {
      expect(screen.getByText(/Local \+ export/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/need.*resync/i)).not.toBeInTheDocument();
  });

  test("renders nothing while workspace info is loading", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => null,
        useDimensions: () => [],
        useAudit: () => [],
      };
    });
    const { CanonicalDestinationChip } = await import(
      "../src/components/CanonicalDestinationChip"
    );
    const { container } = render(<CanonicalDestinationChip />);
    expect(container).toBeEmptyDOMElement();
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
