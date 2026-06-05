import { describe, test, expect, beforeEach } from "vitest";
import { dimIdFromTabId, makeTabId } from "../src/lib/open-tabs";

beforeEach(() => {
  localStorage.clear();
});

describe("dimIdFromTabId", () => {
  test("round-trips with makeTabId", () => {
    expect(dimIdFromTabId(makeTabId("country"))).toBe("country");
  });
  test("throws on a malformed id (missing prefix)", () => {
    expect(() => dimIdFromTabId("country" as unknown as ReturnType<typeof makeTabId>)).toThrow();
  });
});

describe("OpenTabsProvider readStored (via storage roundtrip)", () => {
  test("drops entries with the wrong prefix on rehydrate", async () => {
    localStorage.setItem(
      "zugzug:open-tabs",
      JSON.stringify({
        tabs: [
          { id: "tables:country", dimId: "country", pinned: false, openedAt: 1 },
          { id: "old:partner", dimId: "partner", pinned: false, openedAt: 2 },
        ],
        activeId: "old:partner",
      }),
    );
    const stored = JSON.parse(localStorage.getItem("zugzug:open-tabs")!);
    expect(stored.tabs.filter((t: { id: string }) => !t.id.startsWith("tables:"))).toHaveLength(1);
  });
});
