import { describe, it, expect } from "vitest";
import { tintForSchema, flattenVisible, filterTree, type TreeNode } from "./catalog-tree";

const t = (
  id: string,
  kind: TreeNode["kind"],
  name: string,
  children: TreeNode[] = [],
): TreeNode => ({
  id,
  kind,
  name,
  count: children.length || null,
  depth: id.split("/").length - 1,
  childrenLoaded: children.length > 0,
  children,
});
const tree: TreeNode[] = [
  t("c", "connection", "MotherDuck", [
    t("c/db", "database", "md:demo", [
      t("c/db/authco", "schema", "authco", [t("c/db/authco/users", "table", "users")]),
      t("c/db/billing", "schema", "billing", [t("c/db/billing/invoices", "table", "invoices")]),
    ]),
  ]),
];

describe("tintForSchema", () => {
  it("is deterministic and returns a --tint- css var", () => {
    expect(tintForSchema("authco")).toBe(tintForSchema("authco"));
    expect(tintForSchema("authco")).toMatch(/^var\(--tint-[a-z]+\)$/);
  });
});

describe("flattenVisible", () => {
  it("hides children of closed nodes", () => {
    const flat = flattenVisible(tree, new Set(["c"]));
    expect(flat.map((n) => n.id)).toEqual(["c", "c/db"]); // db closed → schemas hidden
  });
  it("reveals descendants of open nodes", () => {
    const flat = flattenVisible(tree, new Set(["c", "c/db", "c/db/authco"]));
    expect(flat.map((n) => n.id)).toContain("c/db/authco/users");
    expect(flat.map((n) => n.id)).not.toContain("c/db/billing/invoices");
  });
});

describe("filterTree", () => {
  it("keeps only matching branches and force-opens ancestors", () => {
    const { roots, openIds, matchCount } = filterTree(tree, "invoices");
    const flat = flattenVisible(roots, openIds);
    expect(flat.map((n) => n.id)).toContain("c/db/billing/invoices");
    expect(flat.map((n) => n.id)).not.toContain("c/db/authco/users");
    expect(matchCount).toBe(1);
  });
  it("empty query returns the tree unchanged with no forced-open set", () => {
    const { roots, matchCount } = filterTree(tree, "");
    expect(roots).toBe(tree);
    expect(matchCount).toBe(0);
  });
  it("matches on a loaded column name", () => {
    const withCols: TreeNode[] = [
      t("c", "connection", "c", [
        t("c/db", "database", "db", [
          t("c/db/s", "schema", "s", [t("c/db/s/s.users", "table", "users")]),
        ]),
      ]),
    ];
    withCols[0].children[0].children[0].children[0].columns = ["country"];
    const { matchCount } = filterTree(withCols, "country");
    expect(matchCount).toBe(1);
  });
});
