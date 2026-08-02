/**
 * Close-on-scroll for FilterBar's condition editor popover (#197). Mirrors
 * the pattern in lib/overlay-scroll.test.ts and cell-editor-scroll.test.tsx:
 * open the editor for real, let the overlay's arm delay elapse, dispatch a
 * real capture-phase scroll on a node outside it, and assert it closed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ARM_DELAY_MS } from "../../lib/overlay-scroll";
import { FilterBar } from "./FilterBar";
import { makeColumns } from "./test-kit/fixtures";
import type { FilterSet } from "./types";

async function armed(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ARM_DELAY_MS + 20));
  });
}

async function scrollPage(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
}

const emptyFilterSet: FilterSet = { conjunction: "and", conditions: [] };

describe("FilterBar's condition editor closes on scroll", () => {
  it("closes when the page scrolls underneath it", async () => {
    const user = userEvent.setup();
    render(<FilterBar filterSet={emptyFilterSet} columns={makeColumns()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();

    await armed();
    await scrollPage();

    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("does not close for a scroll before the arm delay elapses", async () => {
    const user = userEvent.setup();
    render(<FilterBar filterSet={emptyFilterSet} columns={makeColumns()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await scrollPage();

    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });
});
