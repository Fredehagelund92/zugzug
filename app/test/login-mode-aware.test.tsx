import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

describe("Login — mode-aware", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("password mode — renders email/password form + signup link", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useAuthConfig: () => ({
          mode: "password",
          signupOpen: false,
          allowedDomain: null,
        }),
      };
    });
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
      expect(screen.getByText(/no account.*sign up/i)).toBeInTheDocument();
    });
  });

  test("oidc mode — renders SSO button", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useAuthConfig: () => ({
          mode: "oidc",
          signupOpen: false,
          allowedDomain: "example.com",
          oidcLabel: "Google",
        }),
      };
    });
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/sign in with google/i)).toBeInTheDocument();
      expect(screen.getByText(/@example\.com/i)).toBeInTheDocument();
    });
  });

  test("loading state — auth config not yet fetched", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useAuthConfig: () => null,
      };
    });
    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    // Doesn't crash; renders sign-in heading even before config loads
    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    });
  });
});
