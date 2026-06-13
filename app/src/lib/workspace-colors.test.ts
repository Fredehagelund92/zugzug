import { describe, it, expect } from "vitest";
import { workspaceInitials, workspaceColor, WORKSPACE_COLORS } from "./workspace-colors";

describe("workspaceInitials", () => {
  it("takes first letter of first two words", () => {
    expect(workspaceInitials("Acme Corp")).toBe("AC");
  });
  it("uses first two chars for single word", () => {
    expect(workspaceInitials("Acme")).toBe("AC");
  });
  it("uppercases result", () => {
    expect(workspaceInitials("global ops")).toBe("GO");
  });
  it("handles extra whitespace", () => {
    expect(workspaceInitials("  North  America  ")).toBe("NA");
  });
  it("handles single character label", () => {
    expect(workspaceInitials("A")).toBe("A");
  });
});

describe("workspaceColor", () => {
  it("returns the color if it is in the palette", () => {
    expect(workspaceColor("#ef4444")).toBe("#ef4444");
  });
  it("returns indigo default for null", () => {
    expect(workspaceColor(null)).toBe(WORKSPACE_COLORS[0]);
  });
  it("returns indigo default for an unknown hex", () => {
    expect(workspaceColor("#000000")).toBe(WORKSPACE_COLORS[0]);
  });
});

describe("WORKSPACE_COLORS", () => {
  it("has 10 entries", () => {
    expect(WORKSPACE_COLORS).toHaveLength(10);
  });
});
