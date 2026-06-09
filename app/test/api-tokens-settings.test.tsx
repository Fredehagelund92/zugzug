import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

describe("ApiTokensSection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("lists tokens", async () => {
    vi.doMock("../src/store", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/store")>();
      return {
        ...actual,
        listApiTokens: vi.fn(async () => [
          { id: "tok_1", name: "CI token", created_at: "2026-01-01T00:00:00Z", last_used_at: null },
          {
            id: "tok_2",
            name: "dbt prod",
            created_at: "2026-03-15T00:00:00Z",
            last_used_at: "2026-06-01T00:00:00Z",
          },
        ]),
        createApiToken: vi.fn(),
        revokeApiToken: vi.fn(),
      };
    });

    const { ApiTokensSection } = await import("../src/routes/Settings");
    render(<ApiTokensSection />);

    await waitFor(() => {
      expect(screen.getByText("CI token")).toBeInTheDocument();
      expect(screen.getByText("dbt prod")).toBeInTheDocument();
    });
  });

  test("create token shows value once", async () => {
    const mockCreate = vi.fn(async () => ({
      id: "tok_new",
      name: "my token",
      created_at: "2026-06-09T00:00:00Z",
      last_used_at: null,
      value: "zz_AAAA_secret_token_value",
    }));

    vi.doMock("../src/store", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/store")>();
      return {
        ...actual,
        listApiTokens: vi.fn(async () => []),
        createApiToken: mockCreate,
        revokeApiToken: vi.fn(),
      };
    });

    const { ApiTokensSection } = await import("../src/routes/Settings");
    render(<ApiTokensSection />);

    // Wait for initial load to finish
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create token/i })).toBeInTheDocument();
    });

    // Open the create form
    fireEvent.click(screen.getByRole("button", { name: /create token/i }));

    // Fill in the name
    const nameInput = screen.getByPlaceholderText(/token name/i);
    fireEvent.change(nameInput, { target: { value: "my token" } });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(screen.getByText("zz_AAAA_secret_token_value")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    });
  });

  test("revoke calls revokeApiToken with the token id", async () => {
    const mockRevoke = vi.fn(async () => undefined);

    vi.doMock("../src/store", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/store")>();
      return {
        ...actual,
        listApiTokens: vi.fn(async () => [
          {
            id: "tok_del",
            name: "to be revoked",
            created_at: "2026-01-01T00:00:00Z",
            last_used_at: null,
          },
        ]),
        createApiToken: vi.fn(),
        revokeApiToken: mockRevoke,
      };
    });

    const { ApiTokensSection } = await import("../src/routes/Settings");
    render(<ApiTokensSection />);

    await waitFor(() => {
      expect(screen.getByText("to be revoked")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(mockRevoke).toHaveBeenCalledWith("tok_del");
    });
  });
});
