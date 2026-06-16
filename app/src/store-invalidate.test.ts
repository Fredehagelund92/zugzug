import { describe, it, expect } from "vitest";
import { invalidate, subscribeInvalidate } from "./store";

describe("invalidate", () => {
  it("exposes the expected entries", () => {
    expect(typeof invalidate.currentUser).toBe("function");
    expect(typeof invalidate.tenant).toBe("function");
    expect(typeof invalidate.memberships).toBe("function");
    expect(typeof invalidate.members).toBe("function");
    expect(typeof invalidate.scans).toBe("function");
    expect(typeof invalidate.audit).toBe("function");
    expect(typeof invalidate.warehouses).toBe("function");
    expect(typeof invalidate.tenantList).toBe("function");
    expect(typeof invalidate.adminUsers).toBe("function");
  });

  it("fires registered subscribers (synchronous entries)", () => {
    const calls: string[] = [];
    const unsub1 = subscribeInvalidate("members", (slug) => {
      calls.push(`members:${slug ?? ""}`);
    });

    invalidate.members("acme");

    expect(calls).toContain("members:acme");

    unsub1();
  });

  it("removes subscribers on unsubscribe", () => {
    const fn = (): void => {
      throw new Error("should not fire after unsub");
    };
    const unsub = subscribeInvalidate("warehouses", fn);
    unsub();
    expect(() => invalidate.warehouses()).not.toThrow();
  });
});
