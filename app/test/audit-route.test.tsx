import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The page fetches its own data now: the activity feed from /audit and the
// people-picker roster from /team/members.
vi.mock("../src/api", () => ({
  apiFetch: (path: string) => {
    const body = path.startsWith("/team/members")
      ? []
      : [
          {
            id: "a1",
            at: new Date().toISOString(),
            user: { id: "u1", name: "Alice", initials: "AL" },
            action: "draft.created",
            detail: "channel/web",
          },
        ];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  },
}));

describe("Audit (primary nav)", () => {
  test("renders the PageHeader with kicker 'This workspace'", async () => {
    const { Audit } = await import("../src/routes/Audit");
    render(
      <MemoryRouter>
        <Audit />
      </MemoryRouter>,
    );
    expect(screen.getByText("This workspace")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeInTheDocument();
  });

  test("renders the audit row", async () => {
    const { Audit } = await import("../src/routes/Audit");
    render(
      <MemoryRouter>
        <Audit />
      </MemoryRouter>,
    );
    expect(await screen.findByText("created")).toBeInTheDocument();
    expect(await screen.findByText("channel/web")).toBeInTheDocument();
  });
});
