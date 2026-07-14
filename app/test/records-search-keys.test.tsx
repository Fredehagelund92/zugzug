import { describe, test, expect } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import React, { useRef } from "react";

/**
 * Tests for '/' and Cmd/Ctrl+F keyboard shortcuts that focus the records
 * search box. RecordsBody cannot be mounted in isolation (unexported, heavy
 * mocks), so we mirror its keydown handler on a minimal wrapper that owns the
 * same searchRef — the same approach used in records-search.test.tsx.
 *
 * The handler lives on RecordsBody's root <div> so searchRef is in scope.
 */

function SearchKeyWrapper() {
  const searchRef = useRef<HTMLInputElement | null>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    if (e.key === "/") {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };

  return (
    <div onKeyDown={handleKeyDown} data-testid="records-body" tabIndex={0}>
      <input ref={searchRef} placeholder="Search records…" data-testid="search-input" readOnly />
      <input data-testid="cell-input" placeholder="cell editor" />
    </div>
  );
}

describe("records search key shortcuts", () => {
  test("'/' focuses the search input when focus is on the container", () => {
    const { getByTestId } = render(<SearchKeyWrapper />);
    const body = getByTestId("records-body");
    const search = getByTestId("search-input");

    act(() => {
      fireEvent.keyDown(body, { key: "/" });
    });

    expect(document.activeElement).toBe(search);
  });

  test("Cmd+F focuses the search input and prevents default", () => {
    const { getByTestId } = render(<SearchKeyWrapper />);
    const body = getByTestId("records-body");
    const search = getByTestId("search-input");

    let prevented = false;
    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "preventDefault", {
        value: () => {
          prevented = true;
        },
      });
      body.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(search);
    expect(prevented).toBe(true);
  });

  test("Ctrl+F focuses the search input and prevents default", () => {
    const { getByTestId } = render(<SearchKeyWrapper />);
    const body = getByTestId("records-body");
    const search = getByTestId("search-input");

    let prevented = false;
    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "preventDefault", {
        value: () => {
          prevented = true;
        },
      });
      body.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(search);
    expect(prevented).toBe(true);
  });

  test("'/' does NOT hijack when focus is already in an input", () => {
    const { getByTestId } = render(<SearchKeyWrapper />);
    const cellInput = getByTestId("cell-input");
    const search = getByTestId("search-input");

    act(() => {
      cellInput.focus();
    });

    act(() => {
      fireEvent.keyDown(cellInput, { key: "/" });
    });

    // Focus should remain on the cell input, not the search box
    expect(document.activeElement).toBe(cellInput);
    expect(document.activeElement).not.toBe(search);
  });

  test("Cmd+F does NOT hijack when focus is already in an input", () => {
    const { getByTestId } = render(<SearchKeyWrapper />);
    const cellInput = getByTestId("cell-input");
    const search = getByTestId("search-input");

    act(() => {
      cellInput.focus();
    });

    act(() => {
      fireEvent.keyDown(cellInput, { key: "f", metaKey: true });
    });

    expect(document.activeElement).toBe(cellInput);
    expect(document.activeElement).not.toBe(search);
  });
});
