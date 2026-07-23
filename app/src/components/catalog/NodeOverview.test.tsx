import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NodeOverview } from "./NodeOverview";
import type { TreeNode } from "./catalog-tree";

afterEach(cleanup);
const schema: TreeNode = {
  id: "c/db/authco",
  kind: "schema",
  name: "authco",
  count: 9,
  depth: 2,
  childrenLoaded: false,
  children: [],
};

describe("NodeOverview", () => {
  it("shows the node name, kind tag, and a table count card", () => {
    render(<NodeOverview node={schema} />);
    expect(screen.getByText("authco")).toBeTruthy();
    expect(screen.getByText(/Schema/i)).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.getByText(/tables/i)).toBeTruthy();
  });

  it("connection node with db children carrying count shows summed schemas", () => {
    const connection: TreeNode = {
      id: "c",
      kind: "connection",
      name: "MotherDuck",
      count: null,
      depth: 0,
      childrenLoaded: true,
      children: [
        {
          id: "c/db1",
          kind: "database",
          name: "db1",
          count: 3,
          depth: 1,
          childrenLoaded: false,
          children: [],
        },
        {
          id: "c/db2",
          kind: "database",
          name: "db2",
          count: 5,
          depth: 1,
          childrenLoaded: false,
          children: [],
        },
      ],
    };
    render(<NodeOverview node={connection} />);
    expect(screen.getByText("2")).toBeTruthy(); // databases
    expect(screen.getByText("8")).toBeTruthy(); // schemas = 3 + 5
    // should not show "0" for schemas
    expect(screen.queryByText("0")).toBeNull();
  });

  it("database node with count but no loaded children omits tables card", () => {
    const db: TreeNode = {
      id: "c/db1",
      kind: "database",
      name: "db1",
      count: 4,
      depth: 1,
      childrenLoaded: false,
      children: [],
    };
    render(<NodeOverview node={db} />);
    expect(screen.getByText("4")).toBeTruthy(); // schemas from count
    // The "tables" stat card should not render (only LEAD prose, not the card label)
    expect(screen.queryByText("tables")).toBeNull(); // no tables stat card
  });
});
