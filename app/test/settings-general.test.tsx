import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { General } from "../src/routes/settings/General";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";

vi.mock("../src/api", () => ({ apiFetch: vi.fn().mockResolvedValue({ ok: true }) }));

function wrap(ui: React.ReactNode, role: "viewer" | "editor" | "admin" = "admin") {
  const value: TenantContextValue = tenantFixture(role);
  return (
    <MemoryRouter>
      <TenantProvider value={value}>{ui}</TenantProvider>
    </MemoryRouter>
  );
}

describe("Settings/General", () => {
  beforeEach(() => vi.useFakeTimers());

  it("autosaves the workspace name — no Save button beside it", () => {
    render(wrap(<General />));
    // Scoped to the Identity section: the URL-slug section below it does have a
    // Save button, because a workspace admin may change the address.
    const identity = screen.getByDisplayValue("Acme").closest("section")!;
    expect(within(identity).queryByRole("button", { name: /save/i })).toBeNull();
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
