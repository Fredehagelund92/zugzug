import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourcesFeedStrip } from "./SourcesFeedStrip";
import type { MappingRefTable } from "../../data";

const WIRED = [
  {
    table: "geo.customers",
    column: "country",
    refTable: "country",
    refTableId: "t1",
    present: true,
    rows: 1204,
    values: 40,
    unmapped: 5,
    scanned: true,
    scannedAt: "2026-07-26T10:00:00Z",
  },
];
vi.mock("../../store", () => ({
  useSources: () => WIRED,
  scanSources: vi.fn(async () => 1),
}));
const REF = { id: "t1", refTable: "country" } as unknown as MappingRefTable;

describe("SourcesFeedStrip", () => {
  it("summarizes how many columns feed the table", () => {
    render(<SourcesFeedStrip refTable={REF} />);
    expect(screen.getByText(/1 column feeds this/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-scan/i })).toBeInTheDocument();
  });

  it("renders nothing when no columns are wired", () => {
    const { container } = render(<SourcesFeedStrip refTable={{ id: "nope" } as MappingRefTable} />);
    expect(container).toBeEmptyDOMElement();
  });
});
