import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { Kpi } from "../src/components/Kpi";

describe("Kpi delta tone", () => {
  // The default used to be "up", so a purely descriptive delta ("0 active ·
  // 5 clean") rendered as a green ▲ improvement.
  test("a delta with no direction is neutral — no arrow, no success colour", () => {
    render(<Kpi label="Tables" value="5" delta="0 active · 5 clean" />);
    const delta = screen.getByText(/0 active/);
    expect(delta.textContent).not.toContain("▲");
    expect(delta.className).toContain("text-ink-3");
  });

  test("an explicit direction keeps its arrow and tone", () => {
    render(<Kpi label="Coverage" value="90%" delta="up 4pts" dir="up" />);
    const delta = screen.getByText(/up 4pts/);
    expect(delta.textContent).toContain("▲");
    expect(delta.className).toContain("text-ok");
  });
});
