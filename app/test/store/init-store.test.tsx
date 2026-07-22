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
  test("loads dimensions, current user, and clears loading", async () => {
    const store = await import("../../src/store.ts");

    await store.initStore();

    // currentUser and collaborators are exported module-level lets — readable directly.
    expect(store.currentUser.name).toBe("Me");
    expect(store.currentUser.id).toBe("u1");
    expect(store.collaborators).toEqual([]);

    // Render a tiny probe to read dims via useDimensions() and storeLoading via useStoreLoading().
    function Probe() {
      const dims = store.useDimensions();
      const loading = store.useStoreLoading();
      return (
        <div>
          <span data-testid="dim-count">{dims.length}</span>
          <span data-testid="first-dim">{dims[0]?.dimension ?? ""}</span>
          <span data-testid="loading">{String(loading)}</span>
        </div>
      );
    }

    render(<Probe />);

    expect(screen.getByTestId("dim-count").textContent).toBe("1");
    expect(screen.getByTestId("first-dim").textContent).toBe("Vendors");
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });
});
