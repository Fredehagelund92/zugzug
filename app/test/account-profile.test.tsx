import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Profile } from "../src/routes/account/Profile";
import { authFetch } from "../src/api";

vi.mock("../src/api", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true }),
}));
let authMode: "password" | "oidc" = "password";
vi.mock("../src/store", () => ({
  useCurrentUser: () => ({ name: "Alice", email: "alice@x.com" }),
  useAuthConfig: () => ({ mode: authMode, signupOpen: false, allowedDomain: null }),
  invalidate: { currentUser: vi.fn() },
}));

describe("Account/Profile", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has no explicit Save button for the display name", () => {
    render(<Profile />);
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
  });

  it("autosaves the display name after debounce", async () => {
    const { authFetch } = await import("../src/api");
    (authFetch as ReturnType<typeof vi.fn>).mockClear();
    render(<Profile />);
    const input = screen.getByDisplayValue("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      (authFetch as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
        (c[1]?.body as string)?.includes("Alicia"),
      ),
    ).toBe(true);
  });
});

describe("Account/Profile — password", () => {
  beforeEach(() => {
    authMode = "password";
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockResolvedValue({ ok: true } as Response);
  });

  const fillAndSubmit = async () => {
    fireEvent.change(screen.getByLabelText(/current password/i), {
      target: { value: "old-password" },
    });
    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: "a-much-longer-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
  };

  it("changes the password through the server endpoint", async () => {
    render(<Profile />);
    await fillAndSubmit();
    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "/auth/change-password",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            currentPassword: "old-password",
            newPassword: "a-much-longer-password",
          }),
        }),
      );
    });
    // Fields clear and the change is confirmed.
    await waitFor(() => expect(screen.getByText(/password changed/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/current password/i)).toHaveValue("");
  });

  it("says so when the current password is wrong", async () => {
    vi.mocked(authFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "wrong_current_password" }),
    } as Response);
    render(<Profile />);
    await fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText(/isn.t your current password/i)).toBeInTheDocument(),
    );
  });

  it("passes the server's length policy through", async () => {
    vi.mocked(authFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "password_too_short", minLength: 12 }),
    } as Response);
    render(<Profile />);
    await fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText(/must be at least 12 characters/i)).toBeInTheDocument(),
    );
    // The static hint under the field says the same thing in its own words.
    expect(screen.getAllByText(/at least 12 characters/i)).toHaveLength(2);
  });

  it("is absent when the deployment signs in through an identity provider", () => {
    authMode = "oidc";
    render(<Profile />);
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
  });
});
