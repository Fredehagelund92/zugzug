import { describe, it, expect } from "vitest";
import { tintForSchema, flattenVisible, type TreeNode } from "./catalog-tree";

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
