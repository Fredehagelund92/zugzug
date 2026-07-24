import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { OpenTabsProvider } from "../src/lib/open-tabs";

/**
 * Deep-link contract: ?open=a,brand&active=brand must open those tabs with
 * brand active even when the store loads AFTER the route mounts (initStore is
 * fire-and-forget — TenantLayout.tsx). Regression: the mount-only fold ran
 * against an empty refTables list, dropped every requested tab, and the fallback
 * opened refTables[0] instead.
 *
 * The store is mocked with a mutable refTables list so the test controls when
 * "loading" finishes. Heavy children (TablePane, TableTabStrip) are stubbed;
 * open-tabs state and the URL writer run for real.
 */

const mockState = vi.hoisted(() => ({
  refTables: [] as Array<{ id: string; refTable: string }>,
  listeners: new Set<() => void>(),
}));

vi.mock("../src/store", () => ({
  useRefTables: () => {
    const { useSyncExternalStore } = require("react");
    return useSyncExternalStore(
      (cb: () => void) => {
        mockState.listeners.add(cb);
        return () => mockState.listeners.delete(cb);
      },
      () => mockState.refTables,
    );
  },
  useSources: () => [],
  useCanEdit: () => true,
  // Loading proxy: the store is "loading" until refTables arrive. Gates tab-prune
  // in OpenTabsProvider so deep-linked tabs survive a cold load.
  useStoreLoading: () => mockState.refTables.length === 0,
}));

vi.mock("../src/components/TablePane", () => ({
  TablePane: ({ refTable, isActive }: { refTable: { id: string }; isActive: boolean }) => (
    <div data-testid={`pane-${refTable.id}`} data-active={isActive} />
  ),
}));

vi.mock("../src/components/TableTabStrip", () => ({
  TableTabStrip: () => <div data-testid="tabstrip" />,
}));

vi.mock("../src/components/NoTablesYet", () => ({
  NoTablesYet: () => <div data-testid="no-tables" />,
}));

vi.mock("../src/lib/create-table-modal", () => ({
  useCreateTableModal: () => ({ open: () => {} }),
}));

const DIMS = [
  { id: "a", refTable: "A" },
  { id: "brand", refTable: "Brand" },
];

function setDims(refTables: typeof DIMS) {
  mockState.refTables = refTables;
  for (const cb of mockState.listeners) cb();
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

async function renderRoute(initialUrl: string) {
  const { MasterTables } = await import("../src/routes/MasterTables");
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <OpenTabsProvider slug={`t-${Math.random().toString(36).slice(2, 8)}`}>
        <Routes>
          <Route
            path="/app/:slug/tables"
            element={
              <>
                <MasterTables />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockState.refTables = [];
  mockState.listeners.clear();
  localStorage.clear();
});

describe("Tables deep links", () => {
  test("?open=a,brand&active=brand survives a cold load (refTables arrive after mount)", async () => {
    await renderRoute("/app/default/tables?open=a,brand&active=brand");

    // Store finishes loading after the route mounted (the cold-profile case).
    act(() => setDims(DIMS));

    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("pane-a")).toHaveAttribute("data-active", "false");
    const search = screen.getByTestId("loc").textContent ?? "";
    expect(search).toContain("open=a%2Cbrand");
    expect(search).toContain("active=brand");
  });

  test("legacy ?refTableId= is ignored — does NOT open the tab", async () => {
    await renderRoute("/app/default/tables?refTableId=brand");
    act(() => setDims(DIMS));
    // The legacy fold is removed: pane-brand should NOT be mounted.
    // Fallback opens refTables[0] ("a") because no ?open= was supplied.
    expect(await screen.findByTestId("pane-a")).toHaveAttribute("data-active", "true");
    expect(screen.queryByTestId("pane-brand")).toBeNull();
  });

  test("?open=brand still opens that tab", async () => {
    await renderRoute("/app/default/tables?open=brand&active=brand");
    act(() => setDims(DIMS));
    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
  });

  test("refTables already loaded at mount still folds the URL (warm path)", async () => {
    mockState.refTables = DIMS;
    await renderRoute("/app/default/tables?open=brand&active=brand");
    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
  });

  test("no URL params + loaded refTables falls back to first table", async () => {
    await renderRoute("/app/default/tables");
    act(() => setDims(DIMS));
    expect(await screen.findByTestId("pane-a")).toHaveAttribute("data-active", "true");
  });
});
