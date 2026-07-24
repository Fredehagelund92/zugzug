import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UndoStackProvider } from "../src/components/datagrid";
import { TenantProvider } from "../src/lib/tenant-context";
import { MatchModeBody } from "../src/components/modes/MatchModeBody";
import type { MappingDimension } from "../src/data";

/**
 * ?target= URL param contract for MatchModeBody (Task 6).
 *
 * On mount (active pane only):
 *  - A known key resolves to its label → affordance "Mapping values to <label>"
 *    appears and the filter defaults to "new".
 *  - An unknown/stale key → no affordance, no throw.
 *  - "Map selected" stages every selected source value to the target record via
 *    stageMap (asserted via saveDraft spy).
 *  - Dismiss (×) clears the affordance.
 *
 * Strategy: mount the real MatchModeBody (not a wrapper) with:
 *  - DataGrid stubbed (avoids TanStack Virtual complexity in jsdom)
 *  - GetSuggestionButton stubbed (avoids network hooks)
 *  - store mocked with spy on saveDraft
 */

// ── Store mock ────────────────────────────────────────────────────────────────

const storeMocks = vi.hoisted(() => ({
  saveDraftSpy: vi.fn().mockResolvedValue(undefined),
  discardDraftSpy: vi.fn().mockResolvedValue(undefined),
  commitSpy: vi.fn().mockResolvedValue({ committed: 0, rowsRecovered: 0 }),
}));

vi.mock("../src/store", () => ({
  useDrafts: () => ({}),
  useCanEdit: () => true,
  saveDraft: storeMocks.saveDraftSpy,
  discardDraft: storeMocks.discardDraftSpy,
  commit: storeMocks.commitSpy,
  listDrafts: () => [],
  dkey: (dimId: string, raw: string) => `${dimId}::${raw}`,
  currentUser: { id: "u_ada", name: "Ada Berg", initials: "AB" },
}));

// ── DataGrid stub — renders rows as simple divs so the grid doesn't need ──────
// TanStack Virtual or a real scroll container in jsdom.

vi.mock("../src/components/datagrid", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/components/datagrid")>();
  return {
    ...real,
    DataGrid: ({
      rows,
      rowKey,
      selection,
    }: {
      rows: Array<{ value: string }>;
      rowKey: (r: { value: string }) => string;
      selection?: { selected: string[]; onChange: (s: string[]) => void };
    }) => (
      <div data-testid="datagrid-stub">
        {rows.map((r) => (
          <div
            key={rowKey(r)}
            data-testid={`row-${rowKey(r)}`}
            onClick={() =>
              selection?.onChange(
                selection.selected.includes(rowKey(r))
                  ? selection.selected.filter((v) => v !== rowKey(r))
                  : [...selection.selected, rowKey(r)],
              )
            }
          >
            {rowKey(r)}
          </div>
        ))}
      </div>
    ),
  };
});

// ── Paged scan-values stub — MatchModeBody sources grid rows from the server
// paged hook (not the eager dim.values); supply the same two values here. ──────

vi.mock("../src/lib/use-dim-values-page", () => ({
  useDimValuesPage: () => ({
    items: [
      {
        raw: "usa",
        totalRows: 50,
        isMapped: false,
        mappedLabel: null,
        occurrences: [{ table: "orders", column: "country", rows: 50 }],
      },
      {
        raw: "uk",
        totalRows: 30,
        isMapped: false,
        mappedLabel: null,
        occurrences: [{ table: "orders", column: "country", rows: 30 }],
      },
    ],
    hasMore: false,
    loading: false,
    error: null,
    loadMore: () => {},
    refetch: () => {},
  }),
}));

// ── GetSuggestionButton stub ───────────────────────────────────────────────────

vi.mock("../src/components/GetSuggestionButton", () => ({
  GetSuggestionButton: () => <button>Get suggestion</button>,
}));

// ── Minimal tenant context ─────────────────────────────────────────────────────

const TENANT = {
  id: "acme",
  slug: "acme",
  label: "Acme",
  color: null,
  role: "admin" as const,
  isSuperAdmin: false,
};

// ── Fixture dim ───────────────────────────────────────────────────────────────

const DIM: MappingDimension = {
  id: "country",
  dimension: "Country",
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  rows: 100,
  record: [
    { key: "US", label: "United States", version: 1 },
    { key: "GB", label: "United Kingdom", version: 1 },
  ],
  values: [
    {
      value: "usa",
      status: "new",
      current: null,
      suggestion: null,
      confidence: 0,
      sources: [{ table: "orders", column: "country", rows: 50 }],
    },
    {
      value: "uk",
      status: "new",
      current: null,
      suggestion: null,
      confidence: 0,
      sources: [{ table: "orders", column: "country", rows: 30 }],
    },
  ],
  counts: {
    newCount: 2,
    mappedCount: 0,
    totalDistinct: 2,
    unmappedRowsTotal: 80,
    mappedRowsTotal: 0,
    scannedAt: null,
  },
};

function renderMatch(search: string, isActive = true) {
  return render(
    <MemoryRouter initialEntries={[`/app/acme/tables${search}`]}>
      <TenantProvider value={TENANT}>
        <UndoStackProvider scopeKey="test">
          <MatchModeBody dim={DIM} isActive={isActive} />
        </UndoStackProvider>
      </TenantProvider>
    </MemoryRouter>,
  );
}

const { saveDraftSpy } = storeMocks;

beforeEach(() => {
  vi.clearAllMocks();
  // Clear sessionStorage so filter state is fresh per test.
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("MatchModeBody ?target= resolution", () => {
  test("known target key resolves to label and shows affordance", () => {
    renderMatch("?target=US");

    expect(screen.getByText(/Mapping values to/i)).toBeInTheDocument();
    expect(screen.getByText("United States")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Map selected/i })).toBeInTheDocument();
  });

  test("unknown/stale target key shows no affordance and does not throw", () => {
    renderMatch("?target=STALE_KEY_UNKNOWN");

    expect(screen.queryByText(/Mapping values to/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Map selected/i })).toBeNull();
  });

  test("no ?target= param shows no affordance", () => {
    renderMatch("");

    expect(screen.queryByText(/Mapping values to/i)).toBeNull();
  });

  test("inactive pane ignores ?target= even if key is valid", () => {
    renderMatch("?target=US", false);

    expect(screen.queryByText(/Mapping values to/i)).toBeNull();
  });

  test("dismiss (×) clears the affordance", () => {
    renderMatch("?target=GB");

    expect(screen.getByText(/Mapping values to/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Clear target/i }));

    expect(screen.queryByText(/Mapping values to/i)).toBeNull();
  });

  test("Map selected stages selected source values to the target record", async () => {
    renderMatch("?target=US");

    // Select the "usa" source value via the stubbed DataGrid row.
    fireEvent.click(screen.getByTestId("row-usa"));

    // Click "Map selected".
    fireEvent.click(screen.getByRole("button", { name: /Map selected/i }));

    // saveDraft should be called for "usa" mapping to "United States".
    expect(saveDraftSpy).toHaveBeenCalledWith(
      DIM.id,
      "usa",
      "mapped",
      "United States",
      expect.any(String), // keyFor("United States") → "united_states"
    );
  });

  test("Map selected with multiple values stages all of them", async () => {
    renderMatch("?target=GB");

    // Select both rows.
    fireEvent.click(screen.getByTestId("row-usa"));
    fireEvent.click(screen.getByTestId("row-uk"));

    fireEvent.click(screen.getByRole("button", { name: /Map selected/i }));

    expect(saveDraftSpy).toHaveBeenCalledWith(
      DIM.id,
      "usa",
      "mapped",
      "United Kingdom",
      expect.any(String),
    );
    expect(saveDraftSpy).toHaveBeenCalledWith(
      DIM.id,
      "uk",
      "mapped",
      "United Kingdom",
      expect.any(String),
    );
    expect(saveDraftSpy).toHaveBeenCalledTimes(2);
  });

  test("Map selected with no selection is a no-op", () => {
    renderMatch("?target=US");

    // Nothing selected — just click Map selected.
    fireEvent.click(screen.getByRole("button", { name: /Map selected/i }));

    expect(saveDraftSpy).not.toHaveBeenCalled();
  });
});
