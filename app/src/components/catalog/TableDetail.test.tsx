import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TableDetail } from "./TableDetail";

vi.mock("../../store", async (orig) => ({
  ...(await orig<typeof import("../../store")>()),
  useCanEdit: () => true,
  fetchColumns: () =>
    Promise.resolve([
      { name: "country", type: "VARCHAR" },
      { name: "plan_type", type: "VARCHAR" },
    ]),
  fetchColumnValues: () => Promise.resolve(["US", "DK", "GB"]),
}));
afterEach(cleanup);

const dims = [{ id: "country", dimension: "Country" }] as any;

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
});
