import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollLock } from "../src/lib/use-scroll-lock";

afterEach(() => {
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

  it("does nothing while inactive, and locks once toggled active", () => {
    const { rerender, unmount } = renderHook(({ on }) => useScrollLock(on), {
      initialProps: { on: false },
    });
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.overscrollBehavior).toBe("");
    // The inactive assertion above would also pass against a hook that did
    // nothing at all, so prove the same hook does lock when switched on.
    rerender({ on: true });
    expect(document.body.style.overflow).toBe("hidden");
    rerender({ on: false });
    expect(document.body.style.overflow).toBe("");
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

    inner.unmount();
    expect(document.body.style.overflow).toBe("hidden");

    outer.unmount();
    expect(document.body.style.overflow).toBe("auto");
  });
});
