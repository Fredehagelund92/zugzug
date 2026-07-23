import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CatalogSearchResults, type SearchResultRow } from "./CatalogSearchResults";

const row: SearchResultRow = {
  dbId: "db-1",
  dbName: "md:demo",
  schema: "authco",
  table: "authco.users",
  columns: ["id", "email", "country"],
};

const row2: SearchResultRow = {
  dbId: "db-1",
  dbName: "md:demo",
  schema: "billing",
  table: "billing.invoices",
  columns: ["id", "amount"],
};

describe("CatalogSearchResults", () => {
  it("renders result rows with schema.table and column count", () => {
    render(
      <CatalogSearchResults
        results={[row]}
        searching={false}
        query="users"
        multiDb={false}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("authco.users")).toBeTruthy();
    expect(screen.getByText("3 cols")).toBeTruthy();
  });

  it("shows matched: <column> when table name does not include query but a column does", () => {
    render(
      <CatalogSearchResults
        results={[row]}
        searching={false}
        query="country"
        multiDb={false}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("matched: country")).toBeTruthy();
  });

  it("does not show matched hint when the table name includes the query", () => {
    render(
      <CatalogSearchResults
        results={[row]}
        searching={false}
        query="users"
        multiDb={false}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText(/matched:/)).toBeNull();
  });

  it("calls onSelect with the row when a result button is clicked", () => {
    const onSelect = vi.fn();
    render(
      <CatalogSearchResults
        results={[row]}
        searching={false}
        query="users"
        multiDb={false}
        selectedKey={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("authco.users").closest("button")!);
    expect(onSelect).toHaveBeenCalledWith(row);
  });

  it("shows db name subline when multiDb is true", () => {
    render(
      <CatalogSearchResults
        results={[row]}
        searching={false}
        query="users"
        multiDb={true}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("md:demo")).toBeTruthy();
  });

  it("renders empty state when results is an empty array", () => {
    render(
      <CatalogSearchResults
        results={[]}
        searching={false}
        query="xyz"
        multiDb={false}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("No tables or columns match.")).toBeTruthy();
  });

  it("renders searching state when searching=true and results=null", () => {
    render(
      <CatalogSearchResults
        results={null}
        searching={true}
        query="users"
        multiDb={false}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("searching…")).toBeTruthy();
  });

  it("renders multiple rows", () => {
    render(
      <CatalogSearchResults
        results={[row, row2]}
        searching={false}
        query="id"
        multiDb={false}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("authco.users")).toBeTruthy();
    expect(screen.getByText("billing.invoices")).toBeTruthy();
  });

  it("applies selected styles to the selected row", () => {
    render(
      <CatalogSearchResults
        results={[row]}
        searching={false}
        query="users"
        multiDb={false}
        selectedKey="db-1/authco.users"
        onSelect={() => {}}
      />,
    );
    const btn = screen.getByText("authco.users").closest("button")!;
    expect(btn.className).toContain("bg-accent/15");
  });
});
