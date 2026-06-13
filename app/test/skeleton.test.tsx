import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SkeletonList, SkeletonRow } from "../src/components/Skeleton";

describe("Skeleton", () => {
  it("SkeletonRow renders N column placeholders", () => {
    render(<SkeletonRow columns={[40, 120, 1, 80]} data-testid="row" />);
    const row = screen.getByTestId("row");
    expect(row.children.length).toBe(4);
  });

  it("SkeletonList renders N rows", () => {
    render(<SkeletonList rows={5} columns={[1]} data-testid="list" />);
    const list = screen.getByTestId("list");
    expect(list.children.length).toBe(5);
  });

  it("marks rows as aria-busy", () => {
    render(<SkeletonRow columns={[1]} data-testid="row" />);
    expect(screen.getByTestId("row")).toHaveAttribute("aria-busy", "true");
  });
});
