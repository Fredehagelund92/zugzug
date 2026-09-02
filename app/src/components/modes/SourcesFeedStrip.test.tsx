import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourcesFeedStrip } from "./SourcesFeedStrip";
import { TenantProvider } from "../../lib/tenant-context";
import { tenantFixture } from "../../../test/tenant-fixture";
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

function renderStrip(refTable: MappingRefTable, role: "admin" | "editor" | "viewer" = "editor") {
  return render(
    <TenantProvider value={tenantFixture(role)}>
      <SourcesFeedStrip refTable={refTable} />
    </TenantProvider>,
  );
}

describe("SourcesFeedStrip", () => {
  it("summarizes how many columns feed the table", () => {
    renderStrip(REF);
    expect(screen.getByText(/1 column feeds this/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-scan/i })).toBeInTheDocument();
  });

  it("renders nothing when no columns are wired", () => {
    const { container } = renderStrip({ id: "nope" } as MappingRefTable);
    expect(container).toBeEmptyDOMElement();
  });

  it("re-scans and reports the result when Re-scan is clicked", async () => {
    const user = userEvent.setup();
    renderStrip(REF);
    await user.click(screen.getByRole("button", { name: /re-scan/i }));
    await waitFor(() => expect(scanSources).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Re-scanned 3 columns");
  });

  it("hides Re-scan from a viewer — POST /sources/scan would 403", () => {
    renderStrip(REF, "viewer");
    expect(screen.getByText(/1 column feeds this/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /re-scan/i })).not.toBeInTheDocument();
  });

  it("reports a refused re-scan instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(scanSources).mockRejectedValueOnce(new Error("forbidden"));
    renderStrip(REF);
    await user.click(screen.getByRole("button", { name: /re-scan/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("forbidden", "error"));
  });
});
