import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter } from "react-router-dom";

describe("Signup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("submits signup payload and redirects on success", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ id: "u_1" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
    });

    const { Signup } = await import("../src/routes/Signup");
    render(
      <MemoryRouter>
        <Signup />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenoughpw12" } });
    fireEvent.click(screen.getByRole("button", { name: /sign up/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/signup",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Test User",
            email: "test@example.com",
            password: "longenoughpw12",
          }),
        }),
      );
    });
  });

  test("shows error for weak password", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 400,
      json: async () => ({ error: "password_too_short", minLength: 12 }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Signup } = await import("../src/routes/Signup");
    render(
      <MemoryRouter>
        <Signup />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least 12/i)).toBeInTheDocument();
    });
  });

  test("shows error for not_allowed (allowlist failure)", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 403,
      json: async () => ({ error: "not_allowed" }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Signup } = await import("../src/routes/Signup");
    render(
      <MemoryRouter>
        <Signup />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "longenoughpw12" } });
    fireEvent.click(screen.getByRole("button", { name: /sign up/i }));

    await waitFor(() => {
      expect(screen.getByText(/not been added/i)).toBeInTheDocument();
    });
  });
});
