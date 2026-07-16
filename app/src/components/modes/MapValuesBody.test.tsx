import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// Mock the two heavy bodies + the store so the wrapper is testable in isolation.
vi.mock("./ClusterMapperCard", () => ({ ClusterMapperCard: () => <div>FOCUSED CARD</div> }));
vi.mock("./MatchModeBody", () => ({ MatchModeBody: () => <div>GRID BODY</div> }));

const { draftsRef } = vi.hoisted(() => ({ draftsRef: { current: [] as { dimId: string; status: string }[] } }));
vi.mock("../../store", () => ({
  useDrafts: () => draftsRef.current,
  listDrafts: (dimId: string) => draftsRef.current.filter((d) => d.dimId === dimId),
  commit: vi.fn().mockResolvedValue({ committed: 2, rowsRecovered: 0 }),
  useCanEdit: () => true,
}));
vi.mock("../Toast", () => ({ toast: vi.fn() }));

import { commit } from "../../store";
import { MapValuesBody } from "./MapValuesBody";
import type { MappingDimension } from "../../data";

const commitMock = commit as unknown as ReturnType<typeof vi.fn>;
const DIM = { id: "d1", dimension: "Country" } as unknown as MappingDimension;

beforeEach(() => {
  commitMock.mockClear();
  draftsRef.current = [];
});

describe("MapValuesBody", () => {
  it("defaults to the Focused card and can toggle to the Grid power view", () => {
    const { getByText, queryByText } = render(<MapValuesBody dim={DIM} isActive />);
    expect(getByText("FOCUSED CARD")).toBeTruthy();
    expect(queryByText("GRID BODY")).toBeNull();

    fireEvent.click(getByText("Grid"));
    expect(getByText("GRID BODY")).toBeTruthy();
    expect(queryByText("FOCUSED CARD")).toBeNull();
  });

  it("shows the staged count and publishes via commit", () => {
    draftsRef.current = [
      { dimId: "d1", status: "mapped" },
      { dimId: "d1", status: "mapped" },
      { dimId: "d1", status: "skipped" }, // not counted
      { dimId: "other", status: "mapped" }, // other dim, not counted
    ];
    const { getByText } = render(<MapValuesBody dim={DIM} isActive />);
    expect(getByText(/2 staged changes/i)).toBeTruthy();
    fireEvent.click(getByText(/Publish 2 changes/i));
    expect(commitMock).toHaveBeenCalledWith("d1");
  });

  it("disables publish when nothing is staged", () => {
    const { getByText } = render(<MapValuesBody dim={DIM} isActive />);
    expect((getByText(/Publish 0 changes/i).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
