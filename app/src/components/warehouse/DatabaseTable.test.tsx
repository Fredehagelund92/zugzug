import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DatabaseTable } from "./DatabaseTable";

describe("DatabaseTable", () => {
  it("shows a loading message instead of the empty state while loading", () => {
    const { getByText, queryByText } = render(
      <DatabaseTable databases={[]} loading canAdd={false} onAdd={() => {}} />,
    );
    expect(getByText(/loading databases/i)).toBeTruthy();
    expect(queryByText(/No databases registered yet/)).toBeNull();
  });

  it("shows the empty state once loading is done and there are no rows", () => {
    const { getByText, queryByText } = render(
      <DatabaseTable databases={[]} canAdd={false} onAdd={() => {}} />,
    );
    expect(getByText(/No databases registered yet/)).toBeTruthy();
    expect(queryByText(/loading databases/i)).toBeNull();
  });
});
