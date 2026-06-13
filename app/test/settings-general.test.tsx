import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { General } from "../src/routes/settings/General";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";

vi.mock("../src/api", () => ({ apiFetch: vi.fn().mockResolvedValue({ ok: true }) }));

function wrap(ui: React.ReactNode, role: "viewer" | "editor" | "admin" = "admin") {
  const value: TenantContextValue = {
    id: "t1",
    slug: "acme",
    label: "Acme",
    role,
    isSuperAdmin: false,
  };
  return (
    <MemoryRouter>
      <TenantProvider value={value}>{ui}</TenantProvider>
    </MemoryRouter>
  );
}

describe("Settings/General", () => {
  beforeEach(() => vi.useFakeTimers());

  it("has no explicit Save button", () => {
    render(wrap(<General />));
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("autosaves the workspace label after debounce", async () => {
    const { apiFetch } = await import("../src/api");
    (apiFetch as ReturnType<typeof vi.fn>).mockClear();
    render(wrap(<General />));
    const input = screen.getByDisplayValue("Acme");
    fireEvent.change(input, { target: { value: "Acme Studios" } });
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      (apiFetch as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
        (c[1]?.body as string)?.includes("Acme Studios"),
      ),
    ).toBe(true);
  });
});
