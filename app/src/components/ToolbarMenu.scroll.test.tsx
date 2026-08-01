/**
 * Close-on-scroll for ToolbarMenu (#197). Mirrors the pattern in
 * lib/overlay-scroll.test.ts and datagrid/cell-editor-scroll.test.tsx: open
 * the menu for real, let the overlay's arm delay elapse, dispatch a real
 * capture-phase scroll on a node outside the menu, and assert it closed.
 */
import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ARM_DELAY_MS } from "../lib/overlay-scroll";
import { ToolbarMenu } from "./ToolbarMenu";

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

describe("ToolbarMenu closes on scroll", () => {
  it("closes when the page scrolls underneath it", async () => {
    const user = userEvent.setup();
    render(
      <ToolbarMenu label="More">
        <button type="button">Do a thing</button>
      </ToolbarMenu>,
    );

    await user.click(screen.getByRole("button", { name: /more/i }));
    expect(screen.getByText("Do a thing")).toBeInTheDocument();

    await armed();
    await scrollPage();

    expect(screen.queryByText("Do a thing")).not.toBeInTheDocument();
  });

  it("stays open for a scroll before the arm delay elapses", async () => {
    // Guards against a naive "always dismiss on scroll" implementation, which
    // would close the menu in the very moment it opens.
    const user = userEvent.setup();
    render(
      <ToolbarMenu label="More">
        <button type="button">Do a thing</button>
      </ToolbarMenu>,
    );

    await user.click(screen.getByRole("button", { name: /more/i }));
    await scrollPage();

    expect(screen.getByText("Do a thing")).toBeInTheDocument();
  });
});
