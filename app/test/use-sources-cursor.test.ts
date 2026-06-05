import { describe, test, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSourcesCursor } from "../src/routes/use-sources-cursor";

const KEYS = ["a", "b", "c", "d"] as const;

function mount(visible: readonly string[] = KEYS, withUnmapped: readonly string[] = ["b", "d"]) {
  const toggleDrillAt = vi.fn();
  const focusSearch = vi.fn();
  const hook = renderHook(
    (props: { visibleKeys: readonly string[]; rowsWithUnmapped: readonly string[] }) =>
      useSourcesCursor({
        visibleKeys: props.visibleKeys,
        rowsWithUnmapped: props.rowsWithUnmapped,
        toggleDrillAt,
        focusSearch,
      }),
    { initialProps: { visibleKeys: visible, rowsWithUnmapped: withUnmapped } },
  );
  return { hook, toggleDrillAt, focusSearch };
}

function fireKey(api: ReturnType<typeof mount>["hook"]["result"]["current"], key: string) {
  const e = {
    key,
    target: { tagName: "DIV", isContentEditable: false } as unknown as EventTarget,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent<HTMLElement>;
  act(() => api.onKeyDown(e));
  return e;
}

describe("useSourcesCursor", () => {
  test("starts with cursor null", () => {
    const { hook } = mount();
    expect(hook.result.current.cursor).toBeNull();
  });

  test("j from null lands on first visible row", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "j");
    expect(hook.result.current.cursor).toBe("a");
  });

  test("ArrowDown is an alias for j", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "ArrowDown");
    expect(hook.result.current.cursor).toBe("a");
  });

  test("k from null lands on first visible row", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "k");
    expect(hook.result.current.cursor).toBe("a");
  });

  test("j advances within visibleKeys; stops at last", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "j");
    fireKey(hook.result.current, "j");
    expect(hook.result.current.cursor).toBe("b");
    fireKey(hook.result.current, "j");
    fireKey(hook.result.current, "j");
    expect(hook.result.current.cursor).toBe("d");
    fireKey(hook.result.current, "j"); // past end
    expect(hook.result.current.cursor).toBe("d");
  });

  test("k retreats within visibleKeys; stops at first", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("c"));
    fireKey(hook.result.current, "k");
    expect(hook.result.current.cursor).toBe("b");
    fireKey(hook.result.current, "k");
    fireKey(hook.result.current, "k"); // past start
    expect(hook.result.current.cursor).toBe("a");
  });

  test("Enter calls toggleDrillAt(cursor) when cursor is set", () => {
    const { hook, toggleDrillAt } = mount();
    act(() => hook.result.current.setCursor("c"));
    fireKey(hook.result.current, "Enter");
    expect(toggleDrillAt).toHaveBeenCalledWith("c");
  });

  test("Enter is a no-op when cursor is null", () => {
    const { hook, toggleDrillAt } = mount();
    fireKey(hook.result.current, "Enter");
    expect(toggleDrillAt).not.toHaveBeenCalled();
  });

  test("N from null lands on first rowsWithUnmapped entry", () => {
    const { hook } = mount();
    fireKey(hook.result.current, "N");
    expect(hook.result.current.cursor).toBe("b");
  });

  test("N from a needs-attention row jumps to the next; wraps once", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("b"));
    fireKey(hook.result.current, "n");
    expect(hook.result.current.cursor).toBe("d");
    fireKey(hook.result.current, "n");
    expect(hook.result.current.cursor).toBe("b"); // wrap
  });

  test("N from a non-needs-attention row jumps to the next visible needs-attention", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("a"));
    fireKey(hook.result.current, "n");
    expect(hook.result.current.cursor).toBe("b");
  });

  test("/ calls focusSearch", () => {
    const { hook, focusSearch } = mount();
    fireKey(hook.result.current, "/");
    expect(focusSearch).toHaveBeenCalledOnce();
  });

  test("Escape clears cursor", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("b"));
    fireKey(hook.result.current, "Escape");
    expect(hook.result.current.cursor).toBeNull();
  });

  test("input-focus guard: keys are ignored when target is INPUT", () => {
    const { hook } = mount();
    const e = {
      key: "j",
      target: { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;
    act(() => hook.result.current.onKeyDown(e));
    expect(hook.result.current.cursor).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  test("input-focus guard: keys are ignored when target is contentEditable", () => {
    const { hook } = mount();
    const e = {
      key: "j",
      target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;
    act(() => hook.result.current.onKeyDown(e));
    expect(hook.result.current.cursor).toBeNull();
  });

  test("staleness: cursor clears when visibleKeys no longer contains it", () => {
    const { hook } = mount();
    act(() => hook.result.current.setCursor("c"));
    hook.rerender({ visibleKeys: ["a", "b"], rowsWithUnmapped: ["b"] });
    expect(hook.result.current.cursor).toBeNull();
  });

  test("isFocused reflects the cursor", () => {
    const { hook } = mount();
    expect(hook.result.current.isFocused("a")).toBe(false);
    act(() => hook.result.current.setCursor("a"));
    expect(hook.result.current.isFocused("a")).toBe(true);
    expect(hook.result.current.isFocused("b")).toBe(false);
  });
});
