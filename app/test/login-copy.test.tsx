import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

describe("Login page copy", () => {
  beforeEach(() => {
    vi.resetModules();
    // Silence the useAuthConfig fetch — jsdom has no valid origin for relative URLs
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => null })) as unknown as typeof fetch;
  });

  test("does not mention Better Collective", async () => {
    const { Login } = await import("../src/routes/Login");
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.queryByText(/better collective/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/bettercollective\.com/i)).not.toBeInTheDocument();
  });

  test("uses generic lead copy", async () => {
    const { Login } = await import("../src/routes/Login");
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.getByText(/master data reconciliation/i)).toBeInTheDocument();
  });
});
