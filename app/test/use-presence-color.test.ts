import { describe, test, expect } from "vitest";
import { presenceColorFor } from "../src/lib/use-presence-color";
import { PALETTE_NAMES } from "../src/lib/palette";

describe("presenceColorFor", () => {
  test("returns a stable color for the same userId", () => {
    expect(presenceColorFor("u_alice")).toBe(presenceColorFor("u_alice"));
    expect(presenceColorFor("u_bob")).toBe(presenceColorFor("u_bob"));
  });

  test("color belongs to the palette", () => {
    for (const id of ["u_alice", "u_bob", "u_carol", "u_dan", "u_eve"]) {
      expect(PALETTE_NAMES).toContain(presenceColorFor(id));
    }
  });

  test("distributes across the palette (10 different users → at least 3 distinct colors)", () => {
    const colors = new Set<string>();
    for (let i = 0; i < 10; i++) colors.add(presenceColorFor(`u_user${i}`));
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  test("empty userId still returns a valid palette color", () => {
    expect(PALETTE_NAMES).toContain(presenceColorFor(""));
  });
});
