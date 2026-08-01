import { describe, test, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { createRef } from "react";
import { placeAnchored, AnchoredPopover } from "../src/components/AnchoredPopover";
import { ARM_DELAY_MS } from "../src/lib/overlay-scroll";

afterEach(cleanup);

/** Lets the popover's arming delay elapse, after which a scroll dismisses. */
async function armed(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ARM_DELAY_MS + 20));
  });
}

const VIEWPORT = { width: 1000, height: 800 };
const POP = { width: 320, height: 200 };
const box = (top: number, left: number, w = 100, h = 30) => ({
  top,
  left,
  right: left + w,
  bottom: top + h,
});

describe("placeAnchored", () => {
  test("sits just below the anchor, left edges aligned", () => {
    expect(placeAnchored(box(100, 200), POP, VIEWPORT)).toEqual({ top: 136, left: 200 });
  });

  test("clamps to the right edge instead of overflowing", () => {
    // Anchor near the right edge: left-aligning would put the popover at 950,
    // running 270px past the viewport.
    const { left } = placeAnchored(box(100, 950), POP, VIEWPORT);
    expect(left).toBe(VIEWPORT.width - POP.width - 8);
    expect(left + POP.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  test("clamps to the left edge for a negative anchor", () => {
    expect(placeAnchored(box(100, -50), POP, VIEWPORT).left).toBe(8);
  });

  test("flips above the anchor when it would overflow the bottom", () => {
    // Anchor near the bottom (#195: the ⋯ menu on the last row of a group).
    const { top } = placeAnchored(box(700, 200), POP, VIEWPORT);
    expect(top).toBe(700 - 6 - POP.height);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  test("sits against the bottom edge when it fits neither below nor above", () => {
    const tall = { width: 320, height: 700 };
    const { top } = placeAnchored(box(400, 200), tall, VIEWPORT);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + tall.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  test("right-aligned menus hang their right edge off the anchor's right", () => {
    expect(placeAnchored(box(100, 500), POP, VIEWPORT, "right").left).toBe(600 - POP.width);
  });
});

describe("AnchoredPopover", () => {
  test("portals to document.body so an overflow-hidden ancestor cannot clip it", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <div style={{ overflow: "hidden" }}>
        <div ref={ref}>trigger</div>
        <AnchoredPopover anchor={ref} role="menu" aria-label="More actions">
          <button type="button">Remove source</button>
        </AnchoredPopover>
      </div>,
    );
    // Not inside the clipping ancestor...
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // ...but present in the document, parented to body.
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.parentElement).toBe(document.body);
  });

  test("a zero anchor rect centers rather than pinning to the top-left corner", () => {
    // TablePane falls back to new DOMRect(0,0,0,0) when it can't resolve the
    // column header, which is what put the linked-fields popup in the corner (#203).
    render(
      <AnchoredPopover anchor={{ top: 0, bottom: 0, left: 0, right: 0 }} role="dialog">
        <div>body</div>
      </AnchoredPopover>,
    );
    const el = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(el.style.top).not.toBe("0px");
    expect(el.style.left).not.toBe("0px");
  });
});

/* Close-on-scroll (#197). Touch-scrolling the page behind an open dropdown used
   to drag the dropdown across the screen, because every popover re-placed
   itself against its anchor on every capture-phase scroll. */
describe("AnchoredPopover close-on-scroll", () => {
  function open(onDismiss?: () => void) {
    const ref = createRef<HTMLDivElement>();
    const outside = document.createElement("div");
    document.body.append(outside);
    render(
      <div>
        <div ref={ref}>trigger</div>
        <AnchoredPopover anchor={ref} role="menu" aria-label="More actions" onDismiss={onDismiss}>
          <ul data-testid="inner-list">
            <li>Remove source</li>
          </ul>
        </AnchoredPopover>
      </div>,
    );
    return {
      outside,
      trigger: ref.current!,
      inner: document.body.querySelector('[data-testid="inner-list"]')!,
    };
  }

  const scroll = (node: Node) =>
    act(() => {
      node.dispatchEvent(new Event("scroll", { bubbles: false }));
    });

  test("a scroll outside the panel dismisses it", async () => {
    const onDismiss = vi.fn();
    const { outside } = open(onDismiss);
    await armed();
    scroll(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("a scroll inside the panel does not dismiss it", async () => {
    // Half the consumers put a scrollable list in the panel. Capture-phase
    // scroll on window fires for those too, so flicking through the options
    // must not read as "the page moved".
    const onDismiss = vi.fn();
    const { inner } = open(onDismiss);
    await armed();
    scroll(inner);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("a scroll in the moment it opened does not dismiss it", async () => {
    // Consumers focus something inside the popover in a later effect; the
    // browser may scroll an ancestor to reveal it, which would otherwise close
    // the popover in the moment it opened.
    const onDismiss = vi.fn();
    const { outside } = open(onDismiss);
    scroll(outside);
    expect(onDismiss).not.toHaveBeenCalled();
    await armed();
    scroll(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("without onDismiss it keeps repositioning, as before", async () => {
    const { outside, trigger } = open();
    const el = document.body.querySelector('[role="menu"]') as HTMLElement;
    const before = el.style.top;

    // jsdom reports every rect as 0×0, so move the anchor by stubbing its rect:
    // a re-place must read the new position, a dismiss-instead would not.
    trigger.getBoundingClientRect = () =>
      ({ top: 300, bottom: 330, left: 100, right: 200 }) as DOMRect;
    await armed();
    scroll(outside);

    expect(el.style.top).not.toBe(before);
    expect(el.style.top).toBe("336px");
  });
});
