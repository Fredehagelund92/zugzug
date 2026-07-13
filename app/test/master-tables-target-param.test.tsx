import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { OpenTabsProvider } from "../src/lib/open-tabs";

/**
 * ?target= URL param contract: ?target= must persist only while mode === "match"
 * and must be dropped when the tab switches to any other mode — parity with ?value=.
 * A fresh deep-linked ?target= must survive the initial fold (not stripped before
 * Match mode reads it).
 *
 * The URL writer in MasterTables reads `window.location.search` as its base
 * (to avoid stale react-router captures). In this jsdom test environment,
 * MemoryRouter and window.location are decoupled — we stub window.location.search
 * to the initial URL so the writer sees the same params a real browser would.
 */

const mockState = vi.hoisted(() => ({
  dims: [] as Array<{ id: string; dimension: string }>,
  listeners: new Set<() => void>(),
}));

// Capture onModeChange from the active TablePane so tests can trigger mode switches.
const paneCallbacks = vi.hoisted(
  () => ({ onModeChange: null as ((m: string) => void) | null }),
);

vi.mock("../src/store", () => ({
  useDimensions: () => {
    const { useSyncExternalStore } = require("react");
    return useSyncExternalStore(
      (cb: () => void) => {
        mockState.listeners.add(cb);
        return () => mockState.listeners.delete(cb);
      },
      () => mockState.dims,
    );
  },
  // Provide a source wired to dim "brand" so availableModes returns ["records","match","sources"]
  useSources: () => [{ dimId: "brand", table: "t", column: "c" }],
  useCanEdit: () => true,
}));

vi.mock("../src/components/TablePane", () => ({
  TablePane: ({
    dim,
    isActive,
    onModeChange,
  }: {
    dim: { id: string };
    isActive: boolean;
    onModeChange: (m: string) => void;
  }) => {
    if (isActive) paneCallbacks.onModeChange = onModeChange;
    return <div data-testid={`pane-${dim.id}`} data-active={isActive} />;
  },
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
  { id: "a", dimension: "A" },
  { id: "brand", dimension: "Brand" },
];

function setDims(dims: typeof DIMS) {
  mockState.dims = dims;
  for (const cb of mockState.listeners) cb();
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

// Stub window.location.search so the MasterTables URL writer (which reads
// window.location.search as its base) sees the same params as the MemoryRouter.
function stubWindowSearch(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...window.location, search },
  });
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

const originalLocation = window.location;

beforeEach(() => {
  mockState.dims = [];
  mockState.listeners.clear();
  localStorage.clear();
  paneCallbacks.onModeChange = null;
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("?target= URL param lifecycle", () => {
  test("deep-linked ?target= persists in the URL while tab is in match mode", async () => {
    const initialSearch = "?open=brand&active=brand&mode=match&target=r1";
    stubWindowSearch(initialSearch);
    await renderRoute(`/app/default/tables${initialSearch}`);
    act(() => setDims(DIMS));

    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
    const search = screen.getByTestId("loc").textContent ?? "";
    expect(search).toContain("mode=match");
    expect(search).toContain("target=r1");
  });

  test("switching from match to records mode drops ?target= from the URL", async () => {
    const initialSearch = "?open=brand&active=brand&mode=match&target=r1";
    stubWindowSearch(initialSearch);
    await renderRoute(`/app/default/tables${initialSearch}`);
    act(() => setDims(DIMS));

    // Wait for the pane to appear and confirm target is present in match mode
    expect(await screen.findByTestId("pane-brand")).toHaveAttribute("data-active", "true");
    let search = screen.getByTestId("loc").textContent ?? "";
    expect(search).toContain("target=r1");

    // Switch mode to records via the captured onModeChange callback
    expect(paneCallbacks.onModeChange).not.toBeNull();
    act(() => paneCallbacks.onModeChange!("records"));

    // After mode switch, target must be dropped
    search = screen.getByTestId("loc").textContent ?? "";
    expect(search).not.toContain("target=");
    expect(search).not.toContain("mode="); // records is the default, omitted
  });
});
