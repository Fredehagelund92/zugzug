import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Profile } from "../src/routes/account/Profile";

vi.mock("../src/api", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../src/store", () => ({
  useCurrentUser: () => ({ name: "Alice", email: "alice@x.com" }),
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
