import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CatalogTree } from "./CatalogTree";
import type { TreeNode } from "./catalog-tree";

// #160: the catalog tree must expose tree semantics so keyboard/screen-reader
// users get the same structure sighted users do.
const table: TreeNode = {
  id: "db/main/schema/public/table/users",
  kind: "table",
  name: "users",
  count: 3,
  depth: 2,
  childrenLoaded: true,
  children: [],
};
const schema: TreeNode = {
  id: "db/main/schema/public",
  kind: "schema",
  name: "public",
  count: null,
  depth: 1,
  childrenLoaded: true,
  children: [table],
};
const roots: TreeNode[] = [
  {
    id: "db/main",
    kind: "database",
    name: "main",
    count: null,
    depth: 0,
    childrenLoaded: true,
    children: [schema],
  },
];

describe("CatalogTree a11y (#160)", () => {
  it("exposes role=tree with treeitem rows carrying aria-expanded/aria-selected", () => {
    const { container } = render(
      <CatalogTree
        roots={roots}
        open={new Set([schema.id, "db/main"])}
        loadingIds={new Set()}
        selectedId={table.id}
        onToggle={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(container.querySelector('[role="tree"]')).toBeTruthy();

    const items = Array.from(container.querySelectorAll('[role="treeitem"]'));
    expect(items.length).toBeGreaterThan(0);

    // Expandable nodes (schema) advertise aria-expanded; the open schema is true.
    const schemaItem = items.find((el) => el.textContent?.includes("public"));
    expect(schemaItem?.getAttribute("aria-expanded")).toBe("true");

    // The selected table row is announced as selected; leaf tables have no
    // aria-expanded (nothing to expand).
    const tableItem = items.find((el) => el.textContent?.includes("users"));
    expect(tableItem?.getAttribute("aria-selected")).toBe("true");
    expect(tableItem?.getAttribute("aria-expanded")).toBeNull();
  });
});
