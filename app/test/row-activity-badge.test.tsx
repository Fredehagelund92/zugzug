import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RowActivityBadge } from "../src/components/datagrid/RowActivityBadge";
import type { RowActivityEntry } from "../src/lib/use-row-activity";

function makeEntry(over: Partial<RowActivityEntry> = {}): RowActivityEntry {
  return {
    rowKey: "dk",
    userId: "u_mia",
    displayName: "Mia Berg",
    op: "rename",
    at: new Date().toISOString(),
    ...over,
  };
}

describe("RowActivityBadge", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-06-10T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  test("renders the updater's display name", () => {
    render(<RowActivityBadge entry={makeEntry()} />);
    expect(screen.getByText(/mia berg/i)).toBeInTheDocument();
  });

  test("'just-now' edits render seconds-ago", () => {
    const entry = makeEntry({ at: new Date(Date.now() - 12_000).toISOString() });
    render(<RowActivityBadge entry={entry} />);
    expect(screen.getByText(/12s ago/i)).toBeInTheDocument();
  });

  test("edits 3 minutes ago render 'Nm ago'", () => {
    const entry = makeEntry({ at: new Date(Date.now() - 3 * 60_000).toISOString() });
    render(<RowActivityBadge entry={entry} />);
    expect(screen.getByText(/3m ago/i)).toBeInTheDocument();
  });

  test("edits 2h ago render 'Nh ago'", () => {
    const entry = makeEntry({ at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    render(<RowActivityBadge entry={entry} />);
    expect(screen.getByText(/2h ago/i)).toBeInTheDocument();
  });

  test("edits 20h ago render 'Nh ago' (still under day threshold)", () => {
    const entry = makeEntry({ at: new Date(Date.now() - 20 * 3600_000).toISOString() });
    render(<RowActivityBadge entry={entry} />);
    expect(screen.getByText(/20h ago/i)).toBeInTheDocument();
  });
});
