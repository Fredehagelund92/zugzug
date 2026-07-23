import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { RecordHistoryTimeline } from "./RecordHistoryDrawer";
import type { AuditEntry } from "../store";

const at = new Date().toISOString();
const user = { id: "u1", name: "Frederik", initials: "FH" };

function entry(over: Partial<AuditEntry>): AuditEntry {
  return { id: "x", at, user, action: "Edited record", detail: "", metadata: null, ...over };
}

describe("RecordHistoryTimeline", () => {
  it("renders a field edit as a before → after diff", () => {
    const { getByText } = render(
      <RecordHistoryTimeline
        entries={[
          entry({
            id: "1",
            metadata: { field: "region", label: "Region", before: "Americas", after: "Europe" },
          }),
        ]}
      />,
    );
    expect(getByText("Region")).toBeTruthy();
    // Old value struck through, new value in ink — both present.
    expect(getByText("Americas").className).toContain("line-through");
    expect(getByText("Europe")).toBeTruthy();
  });

  it("shows 'empty' when a value was blank (first set or cleared)", () => {
    const { getByText } = render(
      <RecordHistoryTimeline
        entries={[
          entry({
            id: "1",
            metadata: { field: "population", label: "Population", before: null, after: "331" },
          }),
        ]}
      />,
    );
    expect(getByText("empty")).toBeTruthy();
    expect(getByText("331")).toBeTruthy();
  });

  it("highlights the entry for the focused field only", () => {
    const { getByText } = render(
      <RecordHistoryTimeline
        focusField="region"
        entries={[
          entry({
            id: "1",
            metadata: { field: "region", label: "Region", before: "A", after: "B" },
          }),
          entry({
            id: "2",
            metadata: { field: "population", label: "Population", before: "1", after: "2" },
          }),
        ]}
      />,
    );
    // The focused field's diff card carries the accent highlight; the other doesn't.
    const region = getByText("Region").closest("div")!;
    const population = getByText("Population").closest("div")!;
    expect(region.className).toContain("bg-accent-soft");
    expect(population.className).not.toContain("bg-accent-soft");
  });

  it("falls back to a plain event line for entries without a diff", () => {
    const { getByText, queryByText } = render(
      <RecordHistoryTimeline
        entries={[
          entry({
            id: "1",
            action: "Added canonical",
            detail: "United States (usa)",
            metadata: null,
          }),
        ]}
      />,
    );
    // "Added canonical" → plain "added record", with the detail beneath it.
    expect(getByText("added")).toBeTruthy();
    expect(getByText("United States (usa)")).toBeTruthy();
    expect(queryByText("→")).toBeNull();
  });

  it("groups entries under a day header", () => {
    const { getByText } = render(
      <RecordHistoryTimeline
        entries={[
          entry({
            id: "1",
            metadata: { field: "region", label: "Region", before: "A", after: "B" },
          }),
        ]}
      />,
    );
    expect(getByText("Today")).toBeTruthy();
    expect(getByText("1 change")).toBeTruthy();
  });
});
