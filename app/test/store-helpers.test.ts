import { test, expect, describe } from "vitest";
import { slug, dkey, akey, foldDraftsByValue } from "../src/store";

// slug: lowercases, replaces runs of non-alphanumerics with "_", strips
// leading/trailing underscores.
describe("slug", () => {
  test("lowercases and replaces whitespace with underscore", () => {
    expect(slug("Acme Corp")).toBe("acme_corp");
  });
  test("trims surrounding whitespace (leading/trailing underscores stripped)", () => {
    expect(slug("  Trailing Space  ")).toBe("trailing_space");
  });
  test("collapses runs of non-alphanumerics into a single underscore", () => {
    expect(slug("Foo & Bar / Baz")).toBe("foo_bar_baz");
  });
  test("all-lowercase input passes through unchanged", () => {
    expect(slug("hello")).toBe("hello");
  });
  test("returns empty string for all-special-char input", () => {
    expect(slug("---")).toBe("");
  });
});

describe("dkey", () => {
  test("is stable for the same inputs", () => {
    expect(dkey("brand", "ACME")).toBe(dkey("brand", "ACME"));
  });
  test("differs for different refTables", () => {
    expect(dkey("brand", "x")).not.toBe(dkey("channel", "x"));
  });
  test("differs for different raw values", () => {
    expect(dkey("brand", "a")).not.toBe(dkey("brand", "b"));
  });
  test("format is refTableId::raw", () => {
    expect(dkey("dim1", "val1")).toBe("dim1::val1");
  });
});

describe("akey / foldDraftsByValue", () => {
  const base = {
    refTableId: "country",
    raw: "usa",
    status: "mapped" as const,
    targetKey: null as string | null,
    at: "just now",
    source: "user" as const,
    confidence: null,
    reasoning: null,
    rejectedReason: null,
    rejectedBy: null,
  };
  const mia = {
    ...base,
    targetLabel: "United States",
    user: { id: "u_mia", name: "Mia", initials: "MI" },
    createdAt: "2026-01-01T10:00:00.000Z",
  };
  const bob = {
    ...base,
    targetLabel: "USA Inc",
    user: { id: "u_bob", name: "Bob", initials: "BO" },
    createdAt: "2026-01-01T11:00:00.000Z",
  };

  test("akey separates two people's drafts for the same value", () => {
    expect(akey("country", "usa", "u_mia")).not.toBe(akey("country", "usa", "u_bob"));
  });

  test("folds to one mapping per value, keeping the draft publish will apply", () => {
    const flat = {
      [akey("country", "usa", "u_mia")]: mia,
      [akey("country", "usa", "u_bob")]: bob,
    };
    const folded = foldDraftsByValue(flat);
    // One line in the preview, and it names Bob's target — the newest draft,
    // which is what the server's newest-wins fold commits.
    expect(Object.keys(folded)).toEqual([dkey("country", "usa")]);
    expect(folded[dkey("country", "usa")].targetLabel).toBe("USA Inc");
  });

  test("breaks a created_at tie by author id, exactly as the server fold does", () => {
    const sameTime = { ...bob, createdAt: mia.createdAt };
    const folded = foldDraftsByValue({
      [akey("country", "usa", "u_mia")]: mia,
      [akey("country", "usa", "u_bob")]: sameTime,
    });
    expect(folded[dkey("country", "usa")].user.id).toBe("u_bob");
  });

  test("keeps different values apart", () => {
    const other = { ...mia, raw: "u.s.a." };
    const folded = foldDraftsByValue({
      [akey("country", "usa", "u_mia")]: mia,
      [akey("country", "u.s.a.", "u_mia")]: other,
    });
    expect(Object.keys(folded).sort()).toEqual(
      [dkey("country", "usa"), dkey("country", "u.s.a.")].sort(),
    );
  });
});
