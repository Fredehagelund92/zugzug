import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ModeStrip } from "./ModeStrip";

describe("ModeStrip", () => {
  it("renders the map-values vocabulary — Records / Map values", () => {
    const { getByText, queryByText } = render(
      <ModeStrip modes={["records", "match"]} active="match" onSelect={() => {}} />,
    );
    expect(getByText("Records")).toBeTruthy();
    expect(getByText("Map values")).toBeTruthy();
    // old vocabulary is gone
    expect(queryByText("Match values")).toBeNull();
    expect(queryByText("Wired sources")).toBeNull();
  });

  it("calls onSelect with the mode when a tab is clicked", () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ModeStrip modes={["records", "match"]} active="records" onSelect={onSelect} />,
    );
    fireEvent.click(getByText("Map values"));
    expect(onSelect).toHaveBeenCalledWith("match");
  });
});
