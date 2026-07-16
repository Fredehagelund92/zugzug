import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SourceInfo } from "../../store";

const { sourcesRef } = vi.hoisted(() => ({ sourcesRef: { current: [] as SourceInfo[] } }));
vi.mock("../../store", () => ({
  useSources: () => sourcesRef.current,
  useCanEdit: () => true,
  deriveCanonical: vi.fn().mockResolvedValue({ derived: 0, mode: "connect", matched: 0, unmatched: 0 }),
}));
vi.mock("../../lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({ sources: "/sources", table: () => "/tables" }),
}));
vi.mock("../Toast", () => ({ toast: vi.fn() }));

import { deriveCanonical } from "../../store";
import { SourcesMonitorBody } from "./SourcesMonitorBody";
import type { MappingDimension } from "../../data";

const deriveMock = deriveCanonical as unknown as ReturnType<typeof vi.fn>;
const DIM = { id: "d1", dimension: "Country" } as unknown as MappingDimension;
const NOW = Date.now();

function src(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    table: "orders", column: "ship_country", dimension: "Country", dimId: "d1",
    present: true, rows: 1000, values: 10, unmapped: 0, scanned: true,
    scannedAt: new Date(NOW - 86_400_000).toISOString(),
    ...over,
  };
}
function renderCard() {
  return render(
    <MemoryRouter>
      <SourcesMonitorBody dim={DIM} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  deriveMock.mockClear();
  sourcesRef.current = [];
});

describe("SourcesMonitorBody", () => {
  it("shows the first-run empty state when nothing is wired", () => {
    const { getByText } = renderCard();
    expect(getByText(/Browse warehouse/i)).toBeTruthy();
  });

  it("leads with wiring health and a mapping handoff when values need a record", () => {
    sourcesRef.current = [
      src({ column: "ship_country", unmapped: 24 }),
      src({ column: "bill_country", unmapped: 0 }),
    ];
    const { getByText } = renderCard();
    expect(getByText(/columns feed this table/i)).toBeTruthy(); // header (count is a separate span)
    expect(getByText(/24 new values/i)).toBeTruthy(); // handoff banner
  });

  it("orders broken first and renders its status, no coverage %", () => {
    sourcesRef.current = [
      src({ column: "ship_country", unmapped: 5 }),
      src({ column: "legacy_code", present: false, scanned: true }),
    ];
    const { getAllByRole, queryByText } = renderCard();
    const rows = getAllByRole("listitem");
    expect(within(rows[0]).getByText(/broken/i)).toBeTruthy(); // broken row first
    expect(queryByText(/coverage/i)).toBeNull(); // no coverage KPI on this surface
  });

  it("re-check calls deriveCanonical for that column", () => {
    sourcesRef.current = [src({ column: "ship_country", unmapped: 3 })];
    const { getByLabelText } = renderCard();
    fireEvent.click(getByLabelText(/re-check ship_country/i));
    expect(deriveMock).toHaveBeenCalledWith("d1", "orders", "ship_country");
  });
});
