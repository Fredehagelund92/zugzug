import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollLock } from "../src/lib/use-scroll-lock";

describe("useScrollLock", () => {
  it("locks the body while active", () => {
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("contain");
    unmount();
  });

  it("restores the previous overflow on unmount", () => {
    document.body.style.overflow = "auto";
    const { unmount } = renderHook(() => useScrollLock(true));
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("does nothing while inactive", () => {
    document.body.style.overflow = "";
    renderHook(() => useScrollLock(false));
    expect(document.body.style.overflow).toBe("");
  });
});
