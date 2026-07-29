import { describe, it, expect, vi } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RefTableSectionBody } from "./Triage";
import type { MappingRefTable } from "../data";

const REF_TABLE = {
  id: "country",
  refTable: "country",
  record: [{ label: "Germany" }, { label: "United States" }],
} as unknown as MappingRefTable;

const RAWS = ["Deutschland", "U.S.A.", "Great Britain"];

const page = {
  items: RAWS.map((raw) => ({
    raw,
    totalRows: 100,
    isMapped: false,
    mappedLabel: null,
    occurrences: [{ table: "geo.customers", column: "country", rows: 100 }],
  })),
  loading: false,
  error: null,
  hasMore: false,
  refetch: vi.fn(),
} as unknown as React.ComponentProps<typeof RefTableSectionBody>["page"];

/** Renders the body with a real cursor state, exposing the current cursor raw
 *  so a test can assert where the selection actually landed. */
function Harness() {
  const [cursor, setCursor] = useState<{ refTableId: string; raw: string } | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div data-testid="cursor">{cursor?.raw ?? "none"}</div>
      <RefTableSectionBody
        refTable={REF_TABLE}
        page={page}
        drafts={{}}
        canEdit={false}
        cursor={cursor}
        setCursor={setCursor}
        onSkip={vi.fn()}
        onPick={vi.fn()}
        onRestage={vi.fn()}
        onCommitAll={vi.fn()}
        sentinelRef={sentinelRef}
      />
    </>
  );
}

/** Focus a row the way a click would, flushing the resulting cursor update. */
const focusRow = (raw: string) =>
  act(() => {
    document.querySelector<HTMLLIElement>(`[data-row-key="country::${raw}"]`)!.focus();
  });

describe("Review — arrow-key navigation through values (#199)", () => {
  it("keeps advancing on repeated Down presses", () => {
    render(<Harness />);
    focusRow("Deutschland");
    expect(screen.getByTestId("cursor")).toHaveTextContent("Deutschland");

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByTestId("cursor")).toHaveTextContent("U.S.A.");

    // The second press must move again — before the fix, DOM focus stayed on the
    // first row, so this recomputed from "Deutschland" and stuck on "U.S.A.".
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByTestId("cursor")).toHaveTextContent("Great Britain");
  });

  it("stops at the last row", () => {
    render(<Harness />);
    focusRow("Great Britain");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByTestId("cursor")).toHaveTextContent("Great Britain");
  });

  it("walks back up on repeated Up presses", () => {
    render(<Harness />);
    focusRow("Great Britain");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByTestId("cursor")).toHaveTextContent("U.S.A.");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByTestId("cursor")).toHaveTextContent("Deutschland");
  });

  it("stops at the first row", () => {
    render(<Harness />);
    focusRow("Deutschland");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByTestId("cursor")).toHaveTextContent("Deutschland");
  });

  // #200 — the selected row carries the same full-strength treatment as Map
  // values: an accent bar plus an undimmed wash (it was bg-accent-wash/30).
  it("marks the selected row with the accent bar and full wash", () => {
    render(<Harness />);
    focusRow("U.S.A.");
    const row = document.querySelector('[data-row-key="country::U.S.A."]')!;
    expect(row.className).toContain("border-l-accent");
    expect(row.className).toContain("bg-accent-wash");
    expect(row.className).not.toContain("bg-accent-wash/");
    expect(document.querySelector('[data-row-key="country::Deutschland"]')!.className).toContain(
      "border-l-transparent",
    );
  });
});
