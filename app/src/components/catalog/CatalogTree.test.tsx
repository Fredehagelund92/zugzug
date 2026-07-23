import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { CatalogTree } from "./CatalogTree";
import type { TreeNode } from "./catalog-tree";

afterEach(cleanup);

const node = (
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
  childrenLoaded: true,
  children,
});

const roots = [node("conn", "connection", "MotherDuck", [node("conn/db", "database", "md:demo")])];

const unreachableDb: TreeNode = {
  id: "conn/db-dead",
  kind: "database",
  name: "dead:db",
  count: null,
  depth: 1,
  childrenLoaded: false,
  children: [],
  unreachable: true,
};
const rootsWithUnreachable = [
  node("conn", "connection", "MotherDuck", [node("conn/db", "database", "md:demo"), unreachableDb]),
];

describe("CatalogTree", () => {
  it("renders visible nodes and fires onSelect", () => {
    const onSelect = vi.fn();
    render(
      <CatalogTree
        roots={roots}
        open={new Set(["conn"])}
        loadingIds={new Set()}
        selectedId={null}
        onToggle={() => {}}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("md:demo"));
    expect(onSelect).toHaveBeenCalledWith("conn/db");
  });

  it("hides children of a closed node", () => {
    render(
      <CatalogTree
        roots={roots}
        open={new Set()}
        loadingIds={new Set()}
        selectedId={null}
        onToggle={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText("md:demo")).toBeNull();
  });

  it("shows offline indicator for unreachable database nodes", () => {
    render(
      <CatalogTree
        roots={rootsWithUnreachable}
        open={new Set(["conn"])}
        loadingIds={new Set()}
        selectedId={null}
        onToggle={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId("offline-indicator")).toBeTruthy();
  });

  it("does not show offline indicator for reachable nodes", () => {
    render(
      <CatalogTree
        roots={roots}
        open={new Set(["conn"])}
        loadingIds={new Set()}
        selectedId={null}
        onToggle={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByTestId("offline-indicator")).toBeNull();
  });

  it("shows the node name as a title tooltip on the label span", () => {
    render(
      <CatalogTree
        roots={roots}
        open={new Set(["conn"])}
        loadingIds={new Set()}
        selectedId={null}
        onToggle={() => {}}
        onSelect={() => {}}
      />,
    );
    const span = screen.getByText("md:demo");
    expect(span.getAttribute("title")).toBe("md:demo");
  });
});
