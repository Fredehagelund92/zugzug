import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Workspaces } from "../src/routes/admin/Workspaces";

vi.mock("../src/api", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../src/api";

describe("Admin/Workspaces", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows skeleton rows on first load (no 'Loading…' text)", () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <Workspaces />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/^Loading…$/)).toBeNull();
    const busy = screen.getAllByRole("generic").filter((el) => el.getAttribute("aria-busy") === "true");
    expect(busy.length).toBeGreaterThan(0);
  });

  it("shows EmptyState with CTA when no workspaces", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ tenants: [] }),
    });
    render(
      <MemoryRouter>
        <Workspaces />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText("No workspaces yet")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /create your first workspace/i }),
    ).toBeInTheDocument();
  });
});
