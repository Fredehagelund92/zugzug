import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ARM_DELAY_MS, bindOverlayScroll } from "./overlay-scroll";

/* The dismiss-on-scroll contract every portaled overlay in the app shares.
   Each case drives a real capture-phase scroll event at a real DOM node, so a
   helper that simply never dismissed (the shape all of these had before #197)
   fails every dismissal case, and one that dismissed unconditionally fails
   every exemption case. */

let pop: HTMLElement;
let anchor: HTMLElement;
let outside: HTMLElement;
let place: () => void;
let onDismiss: () => void;
let cleanup: (() => void) | null;

function scrollFrom(target: EventTarget): void {
  target.dispatchEvent(new Event("scroll", { bubbles: false }));
}

beforeEach(() => {
  vi.useFakeTimers();
  pop = document.createElement("div");
  pop.appendChild(document.createElement("ul"));
  anchor = document.createElement("button");
  anchor.appendChild(document.createElement("input"));
  outside = document.createElement("main");
  document.body.append(pop, anchor, outside);
  place = vi.fn();
  onDismiss = vi.fn();
  cleanup = null;
});

afterEach(() => {
  cleanup?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** Bind, then let the arm delay elapse unless the case is about the delay. */
function bind(opts: Partial<Parameters<typeof bindOverlayScroll>[0]> = {}): void {
  cleanup = bindOverlayScroll({ pop, anchor, place, onDismiss, ...opts });
}

describe("bindOverlayScroll", () => {
  it("dismisses when the page scrolls underneath it", () => {
    bind();
    vi.advanceTimersByTime(ARM_DELAY_MS);
    scrollFrom(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(place).not.toHaveBeenCalled();
  });

  it("re-places instead of dismissing when the overlay's own list scrolls", () => {
    bind();
    vi.advanceTimersByTime(ARM_DELAY_MS);
    scrollFrom(pop.firstElementChild!);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("re-places instead of dismissing when the anchor's own input scrolls", () => {
    // A text input scrolls itself once its content overflows horizontally —
    // typing in a narrow cell editor must not close it.
    bind();
    vi.advanceTimersByTime(ARM_DELAY_MS);
    scrollFrom(anchor.firstElementChild!);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("re-places instead of dismissing during the arm delay", () => {
    bind();
    vi.advanceTimersByTime(ARM_DELAY_MS - 1);
    scrollFrom(outside);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(place).toHaveBeenCalledTimes(1);

    // …and dismisses once the delay has elapsed.
    vi.advanceTimersByTime(1);
    scrollFrom(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("only re-places, never dismisses, when no onDismiss is given", () => {
    bind({ onDismiss: undefined });
    vi.advanceTimersByTime(ARM_DELAY_MS);
    scrollFrom(outside);
    scrollFrom(pop.firstElementChild!);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(place).toHaveBeenCalledTimes(2);
  });

  it("re-places on resize and never dismisses on it", () => {
    bind();
    vi.advanceTimersByTime(ARM_DELAY_MS);
    window.dispatchEvent(new Event("resize"));
    expect(place).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("stops listening — and stops the arm timer — after cleanup", () => {
    bind();
    cleanup!();
    cleanup = null;
    vi.advanceTimersByTime(ARM_DELAY_MS * 10);
    scrollFrom(outside);
    window.dispatchEvent(new Event("resize"));
    expect(place).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
