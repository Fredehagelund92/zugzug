import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapValueRow } from "./MapValueRow";
import type { Cluster } from "../../lib/use-ref-table-clusters";
import type { MappingRefTable } from "../../data";

const saveDraft = vi.fn();
vi.mock("../../store", () => ({
  saveDraft: (...a: unknown[]) => saveDraft(...a),
  discardDraft: vi.fn(),
  useDrafts: () => ({}),
  useCanEdit: () => true,
  slug: (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, ""),
  dkey: (id: string, raw: string) => `${id}::${raw}`,
}));

const CLUSTER: Cluster = {
  key: "deutschland",
  rep: "Deutschland",
  rows: 1204,
  mappedCount: 0,
  members: [
    {
      raw: "Deutschland",
      rows: 1000,
      isMapped: false,
      mappedLabel: null,
      occurrences: [{ table: "geo.customers", column: "country", rows: 1000 }],
    },
    {
      raw: "DEUTSCHLAND",
      rows: 204,
      isMapped: false,
      mappedLabel: null,
      occurrences: [{ table: "geo.customers", column: "country", rows: 204 }],
    },
  ],
};
const REF = {
  id: "t1",
  refTable: "country",
  record: [{ key: "germany", label: "Germany", version: 1 }],
} as unknown as MappingRefTable;

// An already-published mapping: the member carries mappedLabel and there is no draft.
const MAPPED_CLUSTER: Cluster = {
  key: "us",
  rep: "US",
  rows: 9302,
  mappedCount: 1,
  members: [
    {
      raw: "US",
      rows: 9302,
      isMapped: true,
      mappedLabel: "United States",
      occurrences: [{ table: "raw.orders", column: "shipping_country", rows: 9302 }],
    },
  ],
};

beforeEach(() => saveDraft.mockClear());

describe("MapValueRow", () => {
  it("shows the representative value and a +N spellings chip", () => {
    render(
      <MapValueRow
        cluster={CLUSTER}
        refTable={REF}
        recordLabels={["Germany"]}
        isCursor={false}
        onFocus={() => {}}
      />,
    );
    expect(screen.getByText("Deutschland")).toBeInTheDocument();
    expect(screen.getByText("+1 spelling")).toBeInTheDocument();
  });

  it("stages a mapped draft for every member when a record is picked", async () => {
    const user = userEvent.setup();
    render(
      <MapValueRow
        cluster={CLUSTER}
        refTable={REF}
        recordLabels={["Germany"]}
        isCursor
        onFocus={() => {}}
      />,
    );
    await user.click(screen.getByLabelText("Record for Deutschland"));
    await user.click(screen.getByText("Germany"));
    expect(saveDraft).toHaveBeenCalledWith("t1", "Deutschland", "mapped", "Germany", "germany");
    expect(saveDraft).toHaveBeenCalledWith("t1", "DEUTSCHLAND", "mapped", "Germany", "germany");
  });

  it("shows the current mapped record for an already-mapped value (no draft)", () => {
    render(
      <MapValueRow
        cluster={MAPPED_CLUSTER}
        refTable={REF}
        recordLabels={["United States"]}
        isCursor={false}
        onFocus={() => {}}
      />,
    );
    expect(screen.getByLabelText("Record for US")).toHaveTextContent("United States");
    expect(screen.getByText("mapped")).toBeInTheDocument();
  });
});
