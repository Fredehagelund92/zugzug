import { describe, test, expect, beforeAll, afterEach, afterAll, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server.ts";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  vi.resetModules();
  window.history.pushState({}, "", "/app/acme/tables");
});

// Shared fixture — a refTable returned by /tables
const REF_TABLE = {
  id: "d1",
  refTable: "Vendors",
  dimTable: "dim_vendors",
  mapTable: "map_vendors",
  keyCol: "vendor_key",
  rows: 0,
  record: [],
  counts: {
    newCount: 0,
    mappedCount: 0,
    totalDistinct: 0,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 0,
    scannedAt: null,
  },
};

const SAVED_DRAFT = {
  refTableId: "d1",
  raw: "acme_corp",
  status: "mapped",
  targetLabel: "Acme Corp",
  targetKey: "acme_corp",
  user: { id: "u1", name: "Me", initials: "M" },
  at: "2025-01-01T00:00:00Z",
  source: "user",
  confidence: null,
  reasoning: null,
  rejectedReason: null,
  rejectedBy: null,
};

describe("saveDraft — optimistic update", () => {
  test("draft appears in state synchronously before PUT resolves", async () => {
    // Use a manually-controlled promise so we can observe state while PUT is pending
    let resolvePut!: () => void;
    const putPending = new Promise<void>((resolve) => {
      resolvePut = resolve;
    });

    server.use(
      http.put("/api/t/:slug/tables/:refTableId/drafts", async () => {
        await putPending;
        return HttpResponse.json({ ok: true });
      }),
      // refreshDrafts fires after the PUT resolves — handle it so the test can settle
      http.get("/api/t/:slug/tables/:refTableId/drafts", () => HttpResponse.json([SAVED_DRAFT])),
    );

    const store = await import("../../src/store.ts");
    await store.initStore();

    // No draft yet
    expect(store.listDrafts("d1")).toHaveLength(0);

    // Start the call — do NOT await; the PUT is blocked by putPending
    const promise = store.saveDraft("d1", "acme_corp", "mapped", "Acme Corp", "acme_corp");

    // Synchronously after call, before any microtask resolution, the draft is in state
    expect(store.listDrafts("d1")).toHaveLength(1);
    const draft = store.listDrafts("d1")[0];
    expect(draft.raw).toBe("acme_corp");
    expect(draft.status).toBe("mapped");
    expect(draft.targetLabel).toBe("Acme Corp");
    expect(draft.targetKey).toBe("acme_corp");

    // Unblock the PUT so the test can exit cleanly
    resolvePut();
    await promise;
  });
});

describe("saveDraft — success", () => {
  test("draft persists after PUT 200 and background refresh", async () => {
    server.use(
      http.put("/api/t/:slug/tables/:refTableId/drafts", () => HttpResponse.json({ ok: true })),
      http.get("/api/t/:slug/tables/:refTableId/drafts", () => HttpResponse.json([SAVED_DRAFT])),
    );

    const store = await import("../../src/store.ts");
    await store.initStore();

    await store.saveDraft("d1", "acme_corp", "mapped", "Acme Corp", "acme_corp");

    // After awaiting, the draft is in state (either from optimistic or background refresh)
    const drafts = store.listDrafts("d1");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].raw).toBe("acme_corp");
    expect(drafts[0].status).toBe("mapped");
    expect(drafts[0].targetLabel).toBe("Acme Corp");
    expect(drafts[0].targetKey).toBe("acme_corp");
  });
});

describe("saveDraft — revert on failure", () => {
  test("optimistic draft is rolled back when PUT returns 500", async () => {
    server.use(
      http.put("/api/t/:slug/tables/:refTableId/drafts", () =>
        HttpResponse.json({ error: "server error" }, { status: 500 }),
      ),
    );

    const store = await import("../../src/store.ts");
    await store.initStore();

    // Start with no draft
    expect(store.listDrafts("d1")).toHaveLength(0);

    // saveDraft throws after rolling back
    await expect(
      store.saveDraft("d1", "acme_corp", "mapped", "Acme Corp", "acme_corp"),
    ).rejects.toThrow();

    // After failure, the optimistic draft has been reverted
    expect(store.listDrafts("d1")).toHaveLength(0);
  });

  test("previous draft is restored if one existed before the failing save", async () => {
    // First, successfully save a draft so there is a pre-existing state
    server.use(
      http.put("/api/t/:slug/tables/:refTableId/drafts", () => HttpResponse.json({ ok: true })),
      http.get("/api/t/:slug/tables/:refTableId/drafts", () =>
        HttpResponse.json([
          { ...SAVED_DRAFT, status: "skipped", targetLabel: null, targetKey: null },
        ]),
      ),
    );

    const store = await import("../../src/store.ts");
    await store.initStore();

    // Seed a "skipped" draft
    await store.saveDraft("d1", "acme_corp", "skipped", null, null);
    expect(store.listDrafts("d1")[0].status).toBe("skipped");

    // Now the server will fail
    server.resetHandlers();
    server.use(
      http.put("/api/t/:slug/tables/:refTableId/drafts", () =>
        HttpResponse.json({ error: "conflict" }, { status: 500 }),
      ),
    );

    // Attempt to change it to "mapped" — should fail and revert
    await expect(
      store.saveDraft("d1", "acme_corp", "mapped", "Acme Corp", "acme_corp"),
    ).rejects.toThrow();

    // The draft is back to its prior state (skipped)
    const drafts = store.listDrafts("d1");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("skipped");
  });
});

describe("createTable — success", () => {
  test("resolves with the new refTable id and refreshes refTables", async () => {
    const NEW_DIM = { ...REF_TABLE, id: "d2", refTable: "Products", dimTable: "dim_products" };

    // Boot returns ONLY the existing refTable, so d2 is absent after initStore().
    server.use(
      http.post("/api/t/:slug/tables", () => HttpResponse.json({ id: "d2" })),
      http.get("/api/t/:slug/tables", () => HttpResponse.json([REF_TABLE])),
    );

    const store = await import("../../src/store.ts");
    await store.initStore();

    // Swap the /tables handler AFTER boot: now d2 only enters the cache if
    // createTable actually runs its post-create refreshDims. (If it didn't, refTables
    // would stay [REF_TABLE] and the assertion below would fail — this gates the refresh,
    // not what initStore already loaded.)
    server.use(http.get("/api/t/:slug/tables", () => HttpResponse.json([REF_TABLE, NEW_DIM])));

    const id = await store.createTable({
      name: "Products",
      mode: "blank",
    });

    // createTable returns the new refTable id on success...
    expect(id).toBe("d2");

    // ...and its post-create refreshDims positively updates the refTables cache.
    // Read via the hook since there is no non-hook refTables accessor.
    const { result } = renderHook(() => store.useRefTables());
    await waitFor(() => expect(result.current.some((d) => d.id === "d2")).toBe(true));
  });
});

describe("createTable — failure", () => {
  test("rejects with Error whose .code matches the server error body", async () => {
    server.use(
      http.post("/api/t/:slug/tables", () =>
        HttpResponse.json(
          { error: "A table named Products already exists", code: "NAME_TAKEN" },
          { status: 422 },
        ),
      ),
    );

    const store = await import("../../src/store.ts");
    await store.initStore();

    let caught: (Error & { code?: string }) | null = null;
    try {
      await store.createTable({ name: "Products", mode: "blank" });
    } catch (e) {
      caught = e as Error & { code?: string };
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).toBe("A table named Products already exists");
    expect(caught?.code).toBe("NAME_TAKEN");
  });

  test("rejects with Error when POST returns 500 without a code", async () => {
    server.use(
      http.post("/api/t/:slug/tables", () =>
        HttpResponse.json({ error: "internal server error" }, { status: 500 }),
      ),
    );

    const store = await import("../../src/store.ts");
    await store.initStore();

    await expect(store.createTable({ name: "Products", mode: "blank" })).rejects.toThrow(
      "internal server error",
    );
  });
});
