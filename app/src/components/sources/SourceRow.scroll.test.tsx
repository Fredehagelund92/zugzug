/**
 * Close-on-scroll for SourceRow's actions menu (#197) — its onDismiss wiring
 * into AnchoredPopover. Mirrors the pattern in lib/overlay-scroll.test.ts and
 * cell-editor-scroll.test.tsx: open the menu for real, let the overlay's arm
 * delay elapse, dispatch a real capture-phase scroll on a node outside it,
 * and assert it closed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ARM_DELAY_MS } from "../../lib/overlay-scroll";
import { SourceRow } from "./SourceRow";
import type { SourceInfo } from "../../store";

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

const row: SourceInfo = {
  refTableId: "t1",
  refTable: "Region",
  table: "public.orders",
  column: "region",
  scanned: true,
  present: true,
  scannedAt: null,
  unmapped: 0,
  rows: 100,
} as SourceInfo;

describe("SourceRow's actions menu closes on scroll", () => {
  it("closes when the page scrolls underneath it", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SourceRow row={row} mapValuesHref="/map" onDerive={vi.fn()} onRemove={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu", { name: "More actions" })).toBeInTheDocument();

    await armed();
    await scrollPage();

    expect(screen.queryByRole("menu", { name: "More actions" })).not.toBeInTheDocument();
  });

  it("does not close for a scroll before the arm delay elapses", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SourceRow row={row} mapValuesHref="/map" onDerive={vi.fn()} onRemove={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await scrollPage();

    expect(screen.getByRole("menu", { name: "More actions" })).toBeInTheDocument();
  });
});
