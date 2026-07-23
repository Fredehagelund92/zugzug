import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TableDetail } from "./TableDetail";
import type { MappingDimension } from "../../data";

const LONG_VALUE =
  "this-is-a-very-long-varchar-sample-value-that-exceeds-eighty-characters-in-total-length";

vi.mock("../../store", async (orig) => ({
  ...(await orig<typeof import("../../store")>()),
  useCanEdit: () => true,
  fetchColumns: () =>
    Promise.resolve([
      { name: "country", type: "VARCHAR" },
      { name: "plan_type", type: "VARCHAR" },
    ]),
  fetchColumnValues: () => Promise.resolve(["US", "DK", "GB", LONG_VALUE]),
}));
afterEach(cleanup);

const dims: MappingDimension[] = [
  {
    id: "country",
    dimension: "Country",
    dimTable: "zugzug.dim_country",
    mapTable: "zugzug.map_country",
    keyCol: "country_key",
    rows: 0,
    canonical: [],
    counts: {
      newCount: 0,
      mappedCount: 0,
      totalDistinct: 0,
      unmappedRowsTotal: 0,
      mappedRowsTotal: 0,
      scannedAt: null,
    },
  },
];

describe("TableDetail", () => {
  it("lists columns with their types", async () => {
    render(
      <TableDetail
        database="db-1"
        tablePath="authco.users"
        connectionLabel="🦆 MotherDuck"
        dims={dims}
      />,
    );
    await waitFor(() => screen.getByText("country"));
    expect(screen.getByText("plan_type")).toBeTruthy();
    expect(screen.getAllByText("VARCHAR").length).toBe(2);
  });

  it("reveals sample values on demand", async () => {
    render(
      <TableDetail
        database="db-1"
        tablePath="authco.users"
        connectionLabel="🦆 MotherDuck"
        dims={dims}
      />,
    );
    await waitFor(() => screen.getAllByText("peek values"));
    fireEvent.click(screen.getAllByText("peek values")[0]);
    await waitFor(() => screen.getByText("US"));
    expect(screen.getByText("DK")).toBeTruthy();
  });

  it("toggle has role=switch and aria-checked reflects state", async () => {
    render(
      <TableDetail
        database="db-1"
        tablePath="authco.users"
        connectionLabel="🦆 MotherDuck"
        dims={dims}
      />,
    );
    // Wait for columns to load
    await waitFor(() => screen.getByText("country"));

    const toggle = screen.getByRole("switch", { name: /only unmapped/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders sample value chips with title and truncate class", async () => {
    render(
      <TableDetail
        database="db-1"
        tablePath="authco.users"
        connectionLabel="🦆 MotherDuck"
        dims={dims}
      />,
    );
    await waitFor(() => screen.getAllByText("peek values"));
    fireEvent.click(screen.getAllByText("peek values")[0]);
    // fetchColumnValues returns ["US", "DK", "GB", LONG_VALUE]; slice(0,4) shows all four
    await waitFor(() => screen.getByText(LONG_VALUE));

    const chip = screen.getByText(LONG_VALUE);
    expect(chip.getAttribute("title")).toBe(LONG_VALUE);
    expect(chip.className).toContain("truncate");
    expect(chip.className).toContain("max-w-[220px]");
  });
});
