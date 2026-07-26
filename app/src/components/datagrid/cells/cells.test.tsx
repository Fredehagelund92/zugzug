import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { test, expect, describe, vi } from "vitest";
import { createRef } from "react";
import type { CellCtx, ColumnDef, EditCtx } from "../types";
import { BooleanCell } from "./BooleanCell.tsx";
import { EmailCell } from "./EmailCell.tsx";
import { UrlCell } from "./UrlCell.tsx";
import { RatingCell } from "./RatingCell.tsx";
import { SelectCell } from "./SelectCell.tsx";
import { LinkedCell } from "./LinkedCell.tsx";
import { NumberCell } from "./NumberCell.tsx";
import { DateCell } from "./DateCell.tsx";

// Minimal CellCtx factory — column comes from a real fixture when config matters.
function ctx(value: unknown, column: ColumnDef<Record<string, unknown>>) {
  return { row: {}, rowKey: "r0", field: "f", value, focused: false, column } as unknown as CellCtx<
    Record<string, unknown>
  >;
}

function boolColumn(): ColumnDef<Record<string, unknown>> {
  return { field: "active", label: "Active", config: { type: "boolean" } };
}

function emailColumn(): ColumnDef<Record<string, unknown>> {
  return { field: "email", label: "Email", config: { type: "email" } };
}

function urlColumn(): ColumnDef<Record<string, unknown>> {
  return { field: "url", label: "URL", config: { type: "url" } };
}

function ratingColumn(ratingMax = 5): ColumnDef<Record<string, unknown>> {
  return { field: "rating", label: "Rating", config: { type: "rating", ratingMax } };
}

function selectColumn(): ColumnDef<Record<string, unknown>> {
  return {
    field: "region",
    label: "Region",
    config: {
      type: "select",
      options: [
        { label: "EMEA", color: null },
        { label: "AMER", color: null },
      ],
    },
  };
}

function linkedColumn(): ColumnDef<Record<string, unknown>> {
  return {
    field: "owner",
    label: "Owner",
    config: {
      type: "linked",
      targetRefTableId: "dim_person",
      displayFields: ["name"],
      candidates: [
        { key: "k1", label: "Alice" },
        { key: "k2", label: "Bob" },
      ],
    },
  };
}

function numberColumn(): ColumnDef<Record<string, unknown>> {
  return { field: "count", label: "Count", config: { type: "number" } };
}

function dateColumn(): ColumnDef<Record<string, unknown>> {
  return { field: "due", label: "Due", config: { type: "date" } };
}

describe("BooleanCell.Renderer", () => {
  test("true value renders aria-label=true", () => {
    render(<BooleanCell.Renderer {...ctx(true, boolColumn())} />);
    expect(screen.getByLabelText("true")).toBeInTheDocument();
  });

  test("string 'true' renders aria-label=true", () => {
    render(<BooleanCell.Renderer {...ctx("true", boolColumn())} />);
    expect(screen.getByLabelText("true")).toBeInTheDocument();
  });

  test("false value renders aria-label=false", () => {
    render(<BooleanCell.Renderer {...ctx(false, boolColumn())} />);
    expect(screen.getByLabelText("false")).toBeInTheDocument();
  });

  test("null renders em dash", () => {
    render(<BooleanCell.Renderer {...ctx(null, boolColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("EmailCell.Renderer", () => {
  test("email value renders mailto anchor", () => {
    render(<EmailCell.Renderer {...ctx("a@b.com", emailColumn())} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "mailto:a@b.com");
  });

  test("empty string renders em dash", () => {
    render(<EmailCell.Renderer {...ctx("", emailColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("null renders em dash", () => {
    render(<EmailCell.Renderer {...ctx(null, emailColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("UrlCell.Renderer", () => {
  test("bare domain renders anchor with https:// prefix and target=_blank", () => {
    render(<UrlCell.Renderer {...ctx("example.com", urlColumn())} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  test("url with existing scheme passes through unchanged", () => {
    render(<UrlCell.Renderer {...ctx("http://example.com", urlColumn())} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "http://example.com");
  });

  test("empty string renders em dash", () => {
    render(<UrlCell.Renderer {...ctx("", urlColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("null renders em dash", () => {
    render(<UrlCell.Renderer {...ctx(null, urlColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("RatingCell.Renderer", () => {
  test("value 3 with ratingMax=5 renders 3 filled and 2 empty stars", () => {
    render(<RatingCell.Renderer {...ctx(3, ratingColumn(5))} />);
    // Stars are rendered as aria-labeled spans: "1 star", "2 stars", "3 stars", etc.
    expect(screen.getByLabelText("1 star")).toBeInTheDocument();
    expect(screen.getByLabelText("2 stars")).toBeInTheDocument();
    expect(screen.getByLabelText("3 stars")).toBeInTheDocument();
    expect(screen.getByLabelText("4 stars")).toBeInTheDocument();
    expect(screen.getByLabelText("5 stars")).toBeInTheDocument();
    // 3 filled stars (★) and 2 empty (☆)
    const stars = screen.getAllByLabelText(/stars?/).map((el) => el.textContent);
    expect(stars).toEqual(["★", "★", "★", "☆", "☆"]);
  });

  test("null renders em dash", () => {
    render(<RatingCell.Renderer {...ctx(null, ratingColumn(5))} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("non-numeric string renders em dash", () => {
    render(<RatingCell.Renderer {...ctx("not-a-number", ratingColumn(5))} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("SelectCell.Renderer", () => {
  test("known option label renders the label", () => {
    render(<SelectCell.Renderer {...ctx("EMEA", selectColumn())} />);
    expect(screen.getByText("EMEA")).toBeInTheDocument();
  });

  test("unknown value falls through as raw text", () => {
    render(<SelectCell.Renderer {...ctx("UNKNOWN", selectColumn())} />);
    expect(screen.getByText("UNKNOWN")).toBeInTheDocument();
  });

  test("null renders em dash", () => {
    render(<SelectCell.Renderer {...ctx(null, selectColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("empty string renders em dash", () => {
    render(<SelectCell.Renderer {...ctx("", selectColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("LinkedCell.Renderer", () => {
  test("known key resolves to label", () => {
    render(<LinkedCell.Renderer {...ctx("k1", linkedColumn())} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  test("unknown key falls through as raw key", () => {
    render(<LinkedCell.Renderer {...ctx("k99", linkedColumn())} />);
    expect(screen.getByText("k99")).toBeInTheDocument();
  });

  test("null renders em dash", () => {
    render(<LinkedCell.Renderer {...ctx(null, linkedColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("empty string renders em dash", () => {
    render(<LinkedCell.Renderer {...ctx("", linkedColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("LinkedCell.Editor (#157)", () => {
  function editorProps(
    candidates: { key: string; label: string }[],
    commit: (v: string | null) => void,
  ) {
    return {
      row: {},
      rowKey: "r0",
      field: "owner",
      value: null,
      column: linkedColumn(),
      candidates,
      commit,
      cancel: () => {},
      anchorRef: createRef<HTMLDivElement>(),
    } as unknown as Parameters<typeof LinkedCell.Editor>[0] & EditCtx<Record<string, unknown>>;
  }

  test("filters candidates by the search query", () => {
    const cands = [
      { key: "k1", label: "Alice" },
      { key: "k2", label: "Bob" },
      { key: "k3", label: "Carol" },
    ];
    render(<LinkedCell.Editor {...editorProps(cands, vi.fn())} />);
    fireEvent.change(screen.getByPlaceholderText(/search records/i), { target: { value: "bo" } });
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.queryByText("Carol")).not.toBeInTheDocument();
  });

  test("clamps a stale highlight when the candidate set shrinks (#157)", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `Person ${i}` }));
    const few = [
      { key: "a", label: "Solo A" },
      { key: "b", label: "Solo B" },
    ];
    const commit = vi.fn();
    const { rerender } = render(<LinkedCell.Editor {...editorProps(many, commit)} />);
    const input = screen.getByPlaceholderText(/search records/i);
    // Move the highlight well past what the shrunken list will contain.
    for (let i = 0; i < 12; i++) fireEvent.keyDown(input, { key: "ArrowDown" });

    // Re-render with far fewer candidates (as a parent narrowing would do).
    rerender(<LinkedCell.Editor {...editorProps(few, commit)} />);
    fireEvent.keyDown(input, { key: "Enter" });

    // The clamp keeps hl in range, so Enter commits a real row (the last of the
    // shrunken list) rather than an out-of-bounds undefined that no-ops.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(["a", "b"]).toContain(commit.mock.calls[0]![0]);
  });
});

describe("NumberCell.Renderer", () => {
  test("integer value renders as text", () => {
    render(<NumberCell.Renderer {...ctx(42, numberColumn())} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  test("null renders em dash", () => {
    render(<NumberCell.Renderer {...ctx(null, numberColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("NaN renders em dash", () => {
    render(<NumberCell.Renderer {...ctx(NaN, numberColumn())} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("number with integer format renders with locale separators", () => {
    const col: ColumnDef<Record<string, unknown>> = {
      field: "count",
      label: "Count",
      config: { type: "number", numberFormat: { format: "integer" } },
    };
    render(<NumberCell.Renderer {...ctx(1234567, col)} />);
    expect(screen.getByText("1,234,567")).toBeInTheDocument();
  });
});

// A long value must truncate (…) within the column instead of spilling into
// adjacent cells, matching the text-cell behaviour. jsdom has no layout, so we
// assert the truncation class is present on the value-bearing element.
describe("cell overflow containment", () => {
  test("select chip label truncates and the chip is width-capped", () => {
    render(<SelectCell.Renderer {...ctx("AMER", selectColumn())} />);
    const label = screen.getByText("AMER");
    expect(label).toHaveClass("truncate");
    expect(label.parentElement).toHaveClass("max-w-full", "min-w-0");
  });

  test("number value truncates", () => {
    render(<NumberCell.Renderer {...ctx(1234567890, numberColumn())} />);
    expect(screen.getByText("1234567890")).toHaveClass("truncate");
  });

  test("date value truncates", () => {
    render(<DateCell.Renderer {...ctx("2026-07-25", dateColumn())} />);
    expect(screen.getByText("2026-07-25")).toHaveClass("truncate");
  });

  test("linked value truncates", () => {
    render(<LinkedCell.Renderer {...ctx("k1", linkedColumn())} />);
    expect(screen.getByText("Alice")).toHaveClass("truncate");
  });
});
