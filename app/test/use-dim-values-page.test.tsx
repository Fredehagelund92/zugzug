import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDimValuesPage } from "../src/lib/use-dim-values-page";

describe("useDimValuesPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              { raw: "Red", totalRows: 10, isMapped: false, mappedLabel: null, occurrences: [] },
            ],
            hasMore: false,
            nextCursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches first page on mount", async () => {
    const { result } = renderHook(() => useDimValuesPage({ dimId: "d1", filter: "new" }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].raw).toBe("Red");
  });
});
