import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

describe("Login page copy", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("does not mention Better Collective", async () => {
    const { Login } = await import("../src/routes/Login");
    render(<Login />);
    expect(screen.queryByText(/better collective/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/bettercollective\.com/i)).not.toBeInTheDocument();
  });

  test("uses generic lead copy", async () => {
    const { Login } = await import("../src/routes/Login");
    render(<Login />);
    expect(screen.getByText(/master data reconciliation/i)).toBeInTheDocument();
  });
});
