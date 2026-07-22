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
});
