/**
 * Close-on-scroll for TableTabStrip's "open a table" dropdown (#197). Mirrors
 * the pattern in lib/overlay-scroll.test.ts and cell-editor-scroll.test.tsx:
 * open the dropdown for real, let the overlay's arm delay elapse, dispatch a
 * real capture-phase scroll on a node outside it, and assert it closed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ARM_DELAY_MS } from "../lib/overlay-scroll";

vi.mock("../store", () => ({
  useRefTables: () => [],
  useDrafts: () => ({}),
  useCanEdit: () => true,
  deleteRefTable: vi.fn(),
}));

vi.mock("../lib/open-tabs", () => ({
  useOpenTabs: () => ({
    tabs: [],
    activeId: null,
    openTab: vi.fn(),
    closeTab: vi.fn(),
    focusTab: vi.fn(),
  }),
}));

const { TableTabStrip } = await import("./TableTabStrip");

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

describe("TableTabStrip's add-tab dropdown closes on scroll", () => {
  it("closes when the page scrolls underneath it", async () => {
    const user = userEvent.setup();
    render(<TableTabStrip />);

    await user.click(screen.getByRole("button", { name: "Open table" }));
    expect(screen.getByPlaceholderText("open a table…")).toBeInTheDocument();

    await armed();
    await scrollPage();

    expect(screen.queryByPlaceholderText("open a table…")).not.toBeInTheDocument();
  });

  it("does not close for a scroll before the arm delay elapses", async () => {
    const user = userEvent.setup();
    render(<TableTabStrip />);

    await user.click(screen.getByRole("button", { name: "Open table" }));
    await scrollPage();

    expect(screen.getByPlaceholderText("open a table…")).toBeInTheDocument();
  });
});
