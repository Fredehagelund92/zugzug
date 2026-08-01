import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TableDetail } from "./TableDetail";

vi.mock("../../store", () => ({
  useCanEdit: () => true,
  deriveRecord: vi.fn(),
  fetchColumnValues: vi.fn().mockResolvedValue([]),
  fetchColumns: vi.fn().mockResolvedValue([{ name: "vendor_name", type: "VARCHAR" }]),
}));

const knob = () => document.querySelector('[role="switch"] > span > span')!;

describe("Only unmapped toggle (#196)", () => {
  beforeEach(async () => {
    render(
      <TableDetail
        database="demo"
        tablePath="raw.invoices"
        connectionLabel="DuckDB"
        refTables={[]}
      />,
    );
    await waitFor(() => expect(screen.getByRole("switch")).toBeInTheDocument());
  });

  // The knob is absolutely positioned. Without an explicit left, it falls back to
  // its static position, which the button's inherited text-align:center puts at
  // the track's midpoint — offsetting every translate-x by half the track, so the
  // knob sat on the right edge when off and slid off the track entirely when on.
  it("pins the knob to the track's left edge so translate-x means what it says", () => {
    expect(knob().className).toContain("left-0");
  });

  // transition-transform covers transform/translate/scale/rotate but NOT
  // background-color, so the knob used to snap dark->white on the first frame
  // while still sliding.
  it("transitions the knob's background alongside its position", () => {
    const cls = knob().className;
    expect(cls).toContain("translate");
    expect(cls).toContain("background-color");
  });

  it("moves the knob across the track when switched on", () => {
    expect(knob().className).toContain("translate-x-0.5");
    fireEvent.click(screen.getByRole("switch"));
    expect(knob().className).toContain("translate-x-[16px]");
  });

  // #196 — the ring that shows after tab-then-click is correct platform
  // behaviour (no new focus event fires, so :focus-visible persists), and it is
  // NOT suppressed here: blurring on click drops focus to <body> and the control
  // stops responding to further Space presses. What was wrong was the look — the
  // blunt global 2px outline. Use the shared soft ring the other hand-rolled
  // controls use (Checkbox, CatalogTree), so it reads as deliberate.
  it("uses the shared focus ring rather than the blunt global outline", () => {
    const cls = screen.getByRole("switch").className;
    expect(cls).toContain("focus-visible:outline-none");
    expect(cls).toContain("focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]");
  });

  it("keeps the button focusable so keyboard activation still works", () => {
    const btn = screen.getByRole("switch");
    expect(btn).not.toHaveAttribute("tabindex", "-1");
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    // Focus must survive activation — a blur-on-click "fix" breaks repeat
    // Space presses for keyboard users.
    expect(document.activeElement).toBe(btn);
  });

  it("reflects state to assistive tech", () => {
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });
});
