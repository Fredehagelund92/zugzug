import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
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
    const region = getByText("Region").closest('[class*="border-l-2"]')!;
    const population = getByText("Population").closest('[class*="border-l-2"]')!;
    expect(region.className).toContain("bg-accent-soft");
    expect(population.className).not.toContain("bg-accent-soft");
  });

  it("falls back to a plain event line for entries without a diff", () => {
    const { getByText, queryByText } = render(
      <RecordHistoryTimeline
        entries={[
          entry({
            id: "1",
            action: "Added record",
            detail: "United States (usa)",
            metadata: null,
          }),
        ]}
      />,
    );
    // "Added record" → plain "added record", with the detail beneath it.
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

  it("offers Restore on past values but not the current one", () => {
    const onRestore = vi.fn();
    // Newest first: region is currently "Europe"; "Americas" is a past value.
    const { queryByLabelText } = render(
      <RecordHistoryTimeline
        onRestore={onRestore}
        entries={[
          entry({
            id: "1",
            metadata: { field: "region", label: "Region", before: "Americas", after: "Europe" },
          }),
          entry({
            id: "2",
            metadata: { field: "region", label: "Region", before: null, after: "Americas" },
          }),
        ]}
      />,
    );
    // The current value (Europe) has no Restore — restoring it is a no-op.
    expect(queryByLabelText('Restore Region to "Europe"')).toBeNull();
    // The past value (Americas) can be restored — but only after confirming.
    const btn = queryByLabelText('Restore Region to "Americas"');
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(onRestore).not.toHaveBeenCalled(); // first click asks to confirm
    fireEvent.click(queryByLabelText('Confirm restoring Region to "Americas"')!);
    expect(onRestore).toHaveBeenCalledWith("region", "Americas");
  });

  it("cancels a restore without committing", () => {
    const onRestore = vi.fn();
    const { queryByLabelText } = render(
      <RecordHistoryTimeline
        onRestore={onRestore}
        entries={[
          entry({
            id: "1",
            metadata: { field: "region", label: "Region", before: "Americas", after: "Europe" },
          }),
          entry({
            id: "2",
            metadata: { field: "region", label: "Region", before: null, after: "Americas" },
          }),
        ]}
      />,
    );
    fireEvent.click(queryByLabelText('Restore Region to "Americas"')!);
    fireEvent.click(queryByLabelText("Cancel restore")!);
    expect(onRestore).not.toHaveBeenCalled();
    // Back to the idle Restore affordance.
    expect(queryByLabelText('Restore Region to "Americas"')).toBeTruthy();
  });

  it("shows no Restore controls without an onRestore handler", () => {
    const { queryByLabelText } = render(
      <RecordHistoryTimeline
        entries={[
          entry({
            id: "1",
            metadata: { field: "region", label: "Region", before: "A", after: "B" },
          }),
          entry({
            id: "2",
            metadata: { field: "region", label: "Region", before: null, after: "A" },
          }),
        ]}
      />,
    );
    expect(queryByLabelText(/^Restore/)).toBeNull();
  });
});
