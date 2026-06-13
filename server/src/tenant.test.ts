import { describe, it, expect } from "bun:test";
import { updateTenantLabel, WORKSPACE_COLORS, updateTenantColor } from "./tenant.ts";

describe("updateTenantLabel", () => {
  it("rejects empty label", async () => {
    await expect(updateTenantLabel("any", "")).rejects.toThrow(/empty/i);
  });
  it("rejects whitespace-only label", async () => {
    await expect(updateTenantLabel("any", "   ")).rejects.toThrow(/empty/i);
  });
});

describe("WORKSPACE_COLORS", () => {
  it("has 10 entries", () => {
    expect(WORKSPACE_COLORS).toHaveLength(10);
  });
  it("includes indigo as first entry", () => {
    expect(WORKSPACE_COLORS[0]).toBe("#6366f1");
  });
});

describe("updateTenantColor", () => {
  it("rejects an invalid hex", async () => {
    await expect(updateTenantColor("any", "#000000")).rejects.toThrow(/invalid color/i);
  });
  it("rejects empty string", async () => {
    await expect(updateTenantColor("any", "")).rejects.toThrow(/invalid color/i);
  });
});
