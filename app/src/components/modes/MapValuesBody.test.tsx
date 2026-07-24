import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// Mock the two heavy bodies + the store so the wrapper is testable in isolation.
vi.mock("./ClusterMapperCard", () => ({ ClusterMapperCard: () => <div>FOCUSED CARD</div> }));
vi.mock("./MatchModeBody", () => ({ MatchModeBody: () => <div>GRID BODY</div> }));

const { draftsRef } = vi.hoisted(() => ({
  draftsRef: { current: [] as { refTableId: string; status: string }[] },
}));
vi.mock("../../store", () => ({
  useDrafts: () => draftsRef.current,
  listDrafts: (refTableId: string) => draftsRef.current.filter((d) => d.refTableId === refTableId),
  commit: vi.fn().mockResolvedValue({ committed: 2, rowsRecovered: 0 }),
  useCanEdit: () => true,
}));
vi.mock("../Toast", () => ({ toast: vi.fn() }));

import { commit } from "../../store";
import { MapValuesBody } from "./MapValuesBody";
import type { MappingRefTable } from "../../data";

const commitMock = commit as unknown as ReturnType<typeof vi.fn>;
const REF_TABLE = { id: "d1", refTable: "Country" } as unknown as MappingRefTable;

beforeEach(() => {
  commitMock.mockClear();
  draftsRef.current = [];
});

describe("MapValuesBody", () => {
  it("defaults to the Focused card and can toggle to the Grid power view", () => {
    const { getByText, queryByText } = render(<MapValuesBody refTable={REF_TABLE} isActive />);
    expect(getByText("FOCUSED CARD")).toBeTruthy();
    expect(queryByText("GRID BODY")).toBeNull();

    fireEvent.click(getByText("Grid"));
    expect(getByText("GRID BODY")).toBeTruthy();
    expect(queryByText("FOCUSED CARD")).toBeNull();
  });

  it("shows the staged count and publishes via commit", () => {
    draftsRef.current = [
      { refTableId: "d1", status: "mapped" },
      { refTableId: "d1", status: "mapped" },
      { refTableId: "d1", status: "skipped" }, // not counted
      { refTableId: "other", status: "mapped" }, // other refTable, not counted
    ];
    const { getByText } = render(<MapValuesBody refTable={REF_TABLE} isActive />);
    expect(getByText(/2 drafts/i)).toBeTruthy();
    fireEvent.click(getByText(/Publish 2 changes/i));
    expect(commitMock).toHaveBeenCalledWith("d1");
  });

  it("disables publish when nothing is staged", () => {
    const { getByText } = render(<MapValuesBody refTable={REF_TABLE} isActive />);
    expect((getByText(/Publish 0 changes/i).closest("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
