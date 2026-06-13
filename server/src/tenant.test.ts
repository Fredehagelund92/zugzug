import { describe, it, expect } from "bun:test";
import { updateTenantLabel } from "./tenant.ts";

describe("updateTenantLabel", () => {
  it("rejects empty label", async () => {
    await expect(updateTenantLabel("any", "")).rejects.toThrow(/empty/i);
  });
  it("rejects whitespace-only label", async () => {
    await expect(updateTenantLabel("any", "   ")).rejects.toThrow(/empty/i);
  });
});
