import { describe, test, expect, beforeAll, afterEach, afterAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { server } from "../msw/server.ts";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  vi.resetModules();
  window.history.pushState({}, "", "/app/acme/tables");
});

describe("initStore() boots the store from the API", () => {
  test("loads refTables, current user, and clears loading", async () => {
    const store = await import("../../src/store.ts");

    await store.initStore();

    // currentUser and collaborators are exported module-level lets — readable directly.
    expect(store.currentUser.name).toBe("Me");
    expect(store.currentUser.id).toBe("u1");
    expect(store.collaborators).toEqual([]);

    // Render a tiny probe to read refTables via useRefTables() and storeLoading via useStoreLoading().
    function Probe() {
      const refTables = store.useRefTables();
      const loading = store.useStoreLoading();
      return (
        <div>
          <span data-testid="refTable-count">{refTables.length}</span>
          <span data-testid="first-refTable">{refTables[0]?.refTable ?? ""}</span>
          <span data-testid="loading">{String(loading)}</span>
        </div>
      );
    }

    render(<Probe />);

    expect(screen.getByTestId("refTable-count").textContent).toBe("1");
    expect(screen.getByTestId("first-refTable").textContent).toBe("Vendors");
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });
});
