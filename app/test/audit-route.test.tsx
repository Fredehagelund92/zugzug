import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/store", () => ({
  useAudit: () => [
    { at: new Date().toISOString(), action: "draft.created", detail: "channel/web" },
  ],
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
    expect(screen.getByText("draft.created")).toBeInTheDocument();
    expect(screen.getByText("channel/web")).toBeInTheDocument();
  });
});
