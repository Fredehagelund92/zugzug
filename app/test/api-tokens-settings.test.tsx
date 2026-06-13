import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { TenantContextValue } from "../src/lib/tenant-context";

const tenantValue: TenantContextValue = {
  id: "t1",
  slug: "acme",
  label: "Acme",
  role: "admin",
  isSuperAdmin: false,
};

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

    const { Tokens: ApiTokensSection } = await import("../src/routes/settings/Tokens");
    const { TenantProvider } = await import("../src/lib/tenant-context");
    render(<TenantProvider value={tenantValue}><ApiTokensSection /></TenantProvider>);

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

    const { Tokens: ApiTokensSection } = await import("../src/routes/settings/Tokens");
    const { TenantProvider } = await import("../src/lib/tenant-context");
    render(<TenantProvider value={tenantValue}><ApiTokensSection /></TenantProvider>);

    // Wait for initial load to finish (empty state renders two "Create token" buttons)
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /create token/i })[0]).toBeInTheDocument();
    });

    // Open the create form
    fireEvent.click(screen.getAllByRole("button", { name: /create token/i })[0]);

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

  test("revoke shows confirm dialog; confirm calls revokeApiToken with the token id", async () => {
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

    const { Tokens: ApiTokensSection } = await import("../src/routes/settings/Tokens");
    const { TenantProvider } = await import("../src/lib/tenant-context");
    render(<TenantProvider value={tenantValue}><ApiTokensSection /></TenantProvider>);

    await waitFor(() => {
      expect(screen.getByText("to be revoked")).toBeInTheDocument();
    });

    // Click Revoke — dialog should appear, API not yet called
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(mockRevoke).not.toHaveBeenCalled();

    // Confirm inside the dialog — API should be called
    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => {
      expect(mockRevoke).toHaveBeenCalledWith("tok_del");
    });
  });

  test("Revoke shows confirm dialog; cancel does not call API", async () => {
    const mockRevoke = vi.fn(async () => undefined);

    vi.doMock("../src/store", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/store")>();
      return {
        ...actual,
        listApiTokens: vi.fn(async () => [
          {
            id: "tok_cancel",
            name: "cancel me",
            created_at: "2026-01-01T00:00:00Z",
            last_used_at: null,
          },
        ]),
        createApiToken: vi.fn(),
        revokeApiToken: mockRevoke,
      };
    });

    const { Tokens: ApiTokensSection } = await import("../src/routes/settings/Tokens");
    const { TenantProvider } = await import("../src/lib/tenant-context");
    render(<TenantProvider value={tenantValue}><ApiTokensSection /></TenantProvider>);

    await waitFor(() => {
      expect(screen.getByText("cancel me")).toBeInTheDocument();
    });

    // Click Revoke — dialog should appear
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Click Cancel — dialog should close, API not called
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
