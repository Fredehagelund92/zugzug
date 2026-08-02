/**
 * Close-on-scroll for HiddenFieldsPopover (#197). Mirrors the pattern in
 * lib/overlay-scroll.test.ts and cell-editor-scroll.test.tsx: render the
 * popover open, let the overlay's arm delay elapse, dispatch a real
 * capture-phase scroll on a node outside it, and assert it closed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ARM_DELAY_MS } from "../../lib/overlay-scroll";
import { HiddenFieldsPopover } from "./HiddenFieldsPopover";
import { makeColumns } from "./test-kit/fixtures";

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

function Harness({ onClose }: { onClose: () => void }) {
  const anchorRef = { current: document.createElement("button") };
  document.body.appendChild(anchorRef.current);
  return (
    <HiddenFieldsPopover
      hidden={[makeColumns()[0]!]}
      anchorRef={anchorRef}
      onUnhide={vi.fn()}
      onClose={onClose}
    />
  );
}

describe("HiddenFieldsPopover closes on scroll", () => {
  it("closes when the page scrolls underneath it", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(screen.getByText(/Hidden fields/)).toBeInTheDocument();

    await armed();
    await scrollPage();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close for a scroll before the arm delay elapses", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await scrollPage();

    expect(onClose).not.toHaveBeenCalled();
  });
});
