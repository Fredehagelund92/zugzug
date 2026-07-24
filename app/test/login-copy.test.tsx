import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

describe("Login page copy", () => {
  beforeEach(() => {
    vi.resetModules();
    // Silence the useAuthConfig fetch — jsdom has no valid origin for relative URLs
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    })) as unknown as typeof fetch;
  });

  test("does not mention Zugzug", async () => {
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/zugzug/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/bettercollective\.com/i)).not.toBeInTheDocument();
  });

  test("uses generic lead copy", async () => {
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    expect(screen.getByText(/pick up where your team left off/i)).toBeInTheDocument();
  });

  it("uses the outcome-oriented tagline, not the abstract one", async () => {
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Reference table mapping.")).not.toBeInTheDocument();
    expect(screen.getByText(/Pick up where your team left off\./i)).toBeInTheDocument();
  });
});
