import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Heavy vi.resetModules() + vi.doMock() + await import() cycle per test.
vi.setConfig({ testTimeout: 15000 });
import { MemoryRouter } from "react-router-dom";

function mockPasswordMode() {
  vi.doMock("../src/store", async (orig) => {
    const real = await orig<typeof import("../src/store")>();
    return {
      ...real,
      useAuthConfig: () => ({ mode: "password", signupOpen: true, allowedDomain: null }),
    };
  });
}

/** Login reads window.location.search and assigns window.location.href; jsdom
 *  can't navigate, so swap in a plain object as the other auth tests do. */
function stubLocation(search: string) {
  Object.defineProperty(window, "location", {
    value: { href: "", search },
    writable: true,
  });
}

function stubFetch() {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).includes("/auth/login")
      ? { status: 200, ok: true, json: async () => ({ id: "u_1" }) }
      : { status: 404, ok: false, json: async () => null },
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("Sign in", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("lands on the page the deep link asked for", async () => {
    mockPasswordMode();
    stubLocation("?next=%2Fapp%2Facme%2Freview%3Ffilter%3Dmapped");
    stubFetch();

    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText(/email/i), {
      target: { value: "a@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(window.location.href).toBe("/app/acme/review?filter=mapped");
    });
  });

  test("lands on /app when there is nothing to come back to", async () => {
    mockPasswordMode();
    stubLocation("");
    stubFetch();

    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText(/email/i), {
      target: { value: "a@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(window.location.href).toBe("/app");
    });
  });

  test("accepts any password — the server decides, not the form", async () => {
    mockPasswordMode();
    stubLocation("");
    const fetchMock = stubFetch();

    const { Login } = await import("../src/routes/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const password = await screen.findByLabelText(/password/i);
    expect(password).not.toHaveAttribute("minlength");

    // A password shorter than the signup policy still reaches the server.
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(password, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (c) =>
            String(c[0]).includes("/auth/login") &&
            String((c[1] as RequestInit)?.body).includes("short"),
        ),
      ).toBe(true);
    });
  });
});
