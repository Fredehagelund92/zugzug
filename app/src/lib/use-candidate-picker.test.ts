import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCandidatePicker, type CandidatePickerOpts } from "./use-candidate-picker";
import type { Candidate, CandidateRecord } from "./cluster-candidates";

const CANDS: Candidate[] = [
  { kind: "record", key: "us", label: "United States", closest: true },
  { kind: "record", key: "gb", label: "United Kingdom", closest: false },
  { kind: "create", label: "USA" },
];

function key(k: string, mods: Partial<React.KeyboardEvent> = {}) {
  return { key: k, preventDefault: vi.fn(), metaKey: false, ctrlKey: false, altKey: false, ...mods } as unknown as React.KeyboardEvent;
}
function opts(over: Partial<CandidatePickerOpts> = {}): CandidatePickerOpts {
  return {
    candidates: CANDS,
    suggestion: null,
    onMap: vi.fn(),
    onSkip: vi.fn(),
    onUndo: vi.fn(),
    onQueryReset: vi.fn(),
    ...over,
  };
}

describe("useCandidatePicker", () => {
  it("defaults active to the suggestion's index, else 0", () => {
    const a = opts({ suggestion: { key: "gb", label: "United Kingdom" } as CandidateRecord });
    const { result } = renderHook(() => useCandidatePicker(a));
    expect(result.current.active).toBe(1); // gb is candidate index 1

    const b = opts();
    const { result: r2 } = renderHook(() => useCandidatePicker(b));
    expect(r2.current.active).toBe(0);
  });

  it("ArrowDown/ArrowUp move the active index, wrapping", () => {
    const { result } = renderHook(() => useCandidatePicker(opts()));
    act(() => result.current.onKeyDown(key("ArrowDown")));
    expect(result.current.active).toBe(1);
    act(() => result.current.onKeyDown(key("ArrowUp")));
    act(() => result.current.onKeyDown(key("ArrowUp")));
    expect(result.current.active).toBe(2); // wrapped past 0
  });

  it("Enter commits the active record via onMap(key, label)", () => {
    const a = opts();
    const { result } = renderHook(() => useCandidatePicker(a));
    act(() => result.current.onKeyDown(key("Enter")));
    expect(a.onMap).toHaveBeenCalledWith("us", "United States");
  });

  it("Enter on a create row resolves the key via slug", () => {
    const a = opts();
    const { result } = renderHook(() => useCandidatePicker(a));
    act(() => result.current.setActive(2)); // the create row
    act(() => result.current.onKeyDown(key("Enter")));
    expect(a.onMap).toHaveBeenCalledWith("usa", "USA"); // slug("USA") === "usa"
  });

  it("Tab accepts the suggestion", () => {
    const a = opts({ suggestion: { key: "gb", label: "United Kingdom" } as CandidateRecord });
    const { result } = renderHook(() => useCandidatePicker(a));
    const e = key("Tab");
    act(() => result.current.onKeyDown(e));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(a.onMap).toHaveBeenCalledWith("gb", "United Kingdom");
  });

  it("Escape resets the query; Cmd/Ctrl+Z undoes", () => {
    const a = opts();
    const { result } = renderHook(() => useCandidatePicker(a));
    act(() => result.current.onKeyDown(key("Escape")));
    expect(a.onQueryReset).toHaveBeenCalled();
    act(() => result.current.onKeyDown(key("z", { metaKey: true })));
    expect(a.onUndo).toHaveBeenCalled();
  });
});
