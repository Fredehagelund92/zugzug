import { describe, test, expect, vi, beforeEach } from "vitest";

/**
 * Verifies that the boot path of refreshDrafts() (no-arg) fetches all drafts
 * in a single batch request to /drafts rather than fanning out one request per
 * refTable via /tables/:id/drafts.
 *
 * Mocks global.fetch (the underlying transport used by apiFetch) so there are
 * no hoisting issues, and tracks full tenant-prefixed URLs so we can assert
 * on exact request counts.
 */

function setPathname(p: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, pathname: p },
    writable: true,
    configurable: true,
  });
}

// Two fake refTables
const DIM_A = "refTable-alpha";
const DIM_B = "refTable-beta";

const FAKE_DIMS = [
  {
    id: DIM_A,
    name: "Alpha",
    position: 0,
    recordMode: "warehouse",
    recordTable: null,
    keyColumn: null,
    labelColumn: null,
    fields: [],
    sources: [],
  },
  {
    id: DIM_B,
    name: "Beta",
    position: 1,
    recordMode: "warehouse",
    recordTable: null,
    keyColumn: null,
    labelColumn: null,
    fields: [],
    sources: [],
  },
];

const FAKE_DRAFTS = [
  {
    refTableId: DIM_A,
    raw: "foo",
    status: "mapped",
    targetLabel: "Foo",
    targetKey: "foo_key",
    user: { id: "u1", name: "Alice", initials: "AL" },
    at: "2024-01-01T00:00:00Z",
    source: "user",
    confidence: null,
    reasoning: null,
  },
  {
    refTableId: DIM_B,
    raw: "bar",
    status: "skipped",
    targetLabel: null,
    targetKey: null,
    user: { id: "u1", name: "Alice", initials: "AL" },
    at: "2024-01-01T00:00:00Z",
    source: "user",
    confidence: null,
    reasoning: null,
  },
];

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("refreshDrafts() boot path — single batch request", () => {
  beforeEach(() => {
    vi.resetModules();
    setPathname("/app/acme/tables");
  });

  test("issues exactly one request to /drafts and zero /tables/:id/drafts calls", async () => {
    const urls: string[] = [];

    global.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      urls.push(url);

      if (url.includes("/drafts") && !url.includes("/tables/")) {
        // Boot path is keyset-paginated (#151): return a single page with no cursor.
        return jsonOk({ drafts: FAKE_DRAFTS, nextCursor: null });
      }
      if (url.includes("/users")) {
        return jsonOk({
          currentUser: { id: "u1", name: "Alice", initials: "AL" },
          collaborators: [],
        });
      }
      if (url.includes("/tables")) {
        return jsonOk(FAKE_DIMS);
      }
      if (url.includes("/warehouse/health")) {
        return jsonOk({ ok: true });
      }
      // audit, sources, preferences → empty array / object
      if (url.includes("/preferences")) {
        return jsonOk({});
      }
      return jsonOk([]);
    }) as unknown as typeof fetch;

    const { initStore, listDrafts, dkey } = await import("../src/store");

    await initStore();

    // Exactly one request to /drafts (the batch endpoint)
    expect(urls.filter((u) => u.endsWith("/drafts")).length).toBe(1);
    // Zero per-refTable draft requests
    expect(urls.some((u) => /\/tables\/.+\/drafts/.test(u))).toBe(false);

    // draftsFlat is populated for both refTables via listDrafts (keyed by dkey(refTableId, raw))
    const draftsA = listDrafts(DIM_A);
    const draftsB = listDrafts(DIM_B);
    expect(draftsA.find((d) => d.raw === "foo")?.status).toBe("mapped");
    expect(draftsB.find((d) => d.raw === "bar")?.status).toBe("skipped");
    // Verify both refTables are present — same as checking dkey(refTableId, raw) in draftsFlat
    expect(draftsA).toHaveLength(1);
    expect(draftsB).toHaveLength(1);
  });

  test("follows the keyset cursor across pages until nextCursor is null (#151)", async () => {
    const draftUrls: string[] = [];

    global.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/drafts") && !url.includes("/tables/")) {
        draftUrls.push(url);
        // First request (no cursor) → page 1 + a cursor; second → page 2, done.
        if (!url.includes("cursor=")) {
          return jsonOk({ drafts: [FAKE_DRAFTS[0]], nextCursor: "CUR2" });
        }
        return jsonOk({ drafts: [FAKE_DRAFTS[1]], nextCursor: null });
      }
      if (url.includes("/users")) {
        return jsonOk({
          currentUser: { id: "u1", name: "Alice", initials: "AL" },
          collaborators: [],
        });
      }
      if (url.includes("/tables")) return jsonOk(FAKE_DIMS);
      if (url.includes("/warehouse/health")) return jsonOk({ ok: true });
      if (url.includes("/preferences")) return jsonOk({});
      return jsonOk([]);
    }) as unknown as typeof fetch;

    const { initStore, listDrafts } = await import("../src/store");
    await initStore();

    // Two draft page requests: the first with no cursor, the second carrying it.
    expect(draftUrls).toHaveLength(2);
    expect(draftUrls[0].includes("cursor=")).toBe(false);
    expect(draftUrls[1]).toContain("cursor=CUR2");

    // Both pages' drafts landed in the store.
    expect(listDrafts(DIM_A).find((d) => d.raw === "foo")?.status).toBe("mapped");
    expect(listDrafts(DIM_B).find((d) => d.raw === "bar")?.status).toBe("skipped");
  });
});
