import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourcesFeedStrip } from "./SourcesFeedStrip";
import { scanSources } from "../../store";
import { toast } from "../Toast";
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
  scanSources: vi.fn(async () => 3),
}));
vi.mock("../Toast", () => ({ toast: vi.fn() }));
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

  it("re-scans and reports the result when Re-scan is clicked", async () => {
    const user = userEvent.setup();
    render(<SourcesFeedStrip refTable={REF} />);
    await user.click(screen.getByRole("button", { name: /re-scan/i }));
    await waitFor(() => expect(scanSources).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Re-scanned 3 columns");
  });
});
