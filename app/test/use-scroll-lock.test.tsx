import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollLock } from "../src/lib/use-scroll-lock";

// #main stands in for AppShell's real scroll container — the element the
// hook actually needs to freeze, since document.body never scrolls in this
// app (every shell confines scrolling to an inner flex child).
let main: HTMLElement;

beforeEach(() => {
  main = document.createElement("main");
  main.id = "main";
  document.body.appendChild(main);
});

afterEach(() => {
  main.remove();
  document.body.style.overflow = "";
  document.body.style.overscrollBehavior = "";
});

describe("useScrollLock", () => {
  it("locks the body while active", () => {
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("contain");
    unmount();
  });

  it("locks the #main scroll container while active — the actual scroller in this app", () => {
    const { unmount } = renderHook(() => useScrollLock(true));
    // "clip", not "hidden": hidden still permits script-driven scrollTop/
    // scrollBy (it only removes the scrollbar/drag gesture), so it wouldn't
    // actually stop anything. clip disallows scrolling by any means.
    expect(main.style.overflow).toBe("clip");
    unmount();
  });

  it("compensates a scrolled container with a transform so clip doesn't visually snap it to the top", () => {
    // overflow:clip forces the browser to repaint the container as if
    // scrolled to 0 the instant it's applied. Counter that by shifting the
    // container's children up by the same amount with a transform, which
    // doesn't affect layout — only where they paint.
    const child = document.createElement("div");
    main.appendChild(child);
    main.scrollTop = 120;

    const { unmount } = renderHook(() => useScrollLock(true));
    expect(child.style.transform).toBe("translateY(-120px)");

    unmount();
    expect(child.style.transform).toBe("");
  });

  it("doesn't touch children's transform when the container isn't scrolled", () => {
    const child = document.createElement("div");
    main.appendChild(child);
    // main.scrollTop stays 0 — nothing to compensate for.

    const { unmount } = renderHook(() => useScrollLock(true));
    expect(child.style.transform).toBe("");
    unmount();
  });

  it("restores the previous overflow and overscroll on unmount", () => {
    document.body.style.overflow = "auto";
    document.body.style.overscrollBehavior = "auto";
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("contain");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.overscrollBehavior).toBe("auto");
  });

  it("restores a pre-existing inline overflow on the container on unmount", () => {
    main.style.overflow = "auto";
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(main.style.overflow).toBe("clip");
    unmount();
    expect(main.style.overflow).toBe("auto");
  });

  it("falls back to .flex-1.overflow-y-auto when there is no #main (the admin shells)", () => {
    main.remove();
    const adminMain = document.createElement("div");
    adminMain.className = "flex-1 overflow-y-auto";
    document.body.appendChild(adminMain);

    const { unmount } = renderHook(() => useScrollLock(true));
    expect(adminMain.style.overflow).toBe("clip");
    unmount();
    expect(adminMain.style.overflow).toBe("");

    adminMain.remove();
  });

  it("does nothing while inactive, and locks once toggled active", () => {
    const { rerender, unmount } = renderHook(({ on }) => useScrollLock(on), {
      initialProps: { on: false },
    });
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.overscrollBehavior).toBe("");
    expect(main.style.overflow).toBe("");
    // The inactive assertion above would also pass against a hook that did
    // nothing at all, so prove the same hook does lock when switched on.
    rerender({ on: true });
    expect(document.body.style.overflow).toBe("hidden");
    expect(main.style.overflow).toBe("clip");
    rerender({ on: false });
    expect(document.body.style.overflow).toBe("");
    expect(main.style.overflow).toBe("");
    unmount();
  });

  it("stays locked until the last of two stacked overlays closes", () => {
    // Task 8 stacks these for real: the nav drawer can open the command
    // palette over itself. A per-hook snapshot would have the inner lock
    // record "hidden" and restore it, freezing the page for good.
    document.body.style.overflow = "auto";
    const outer = renderHook(() => useScrollLock(true));
    const inner = renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");
    expect(main.style.overflow).toBe("clip");

    inner.unmount();
    expect(document.body.style.overflow).toBe("hidden");
    expect(main.style.overflow).toBe("clip");

    outer.unmount();
    expect(document.body.style.overflow).toBe("auto");
    expect(main.style.overflow).toBe("");
  });
});
