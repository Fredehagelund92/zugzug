/**
 * A deep link opened while signed out must survive the bounce to /login.
 * Covers: app/src/components/BootGate.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mockAuthFetch = vi.fn();
vi.mock("../src/api", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

describe("BootGate — signed out", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
    mockAuthFetch.mockResolvedValue({ status: 401, ok: false });
  });

  const stubLocation = (pathname: string, search = "", hash = "") => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { pathname, search, hash, replace },
      writable: true,
    });
    return replace;
  };

  it("sends the page the user asked for along to /login", async () => {
    const replace = stubLocation("/app/acme/settings/warehouse", "", "#scans");
    const { BootGate } = await import("../src/components/BootGate");
    render(<BootGate>{() => <div />}</BootGate>);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/login?next=%2Fapp%2Facme%2Fsettings%2Fwarehouse%23scans",
      );
    });
  });

  it("sends a bare /login when there is nowhere to come back to", async () => {
    const replace = stubLocation("/");
    const { BootGate } = await import("../src/components/BootGate");
    render(<BootGate>{() => <div />}</BootGate>);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login");
    });
  });
});
