/**
 * Close-on-scroll for Audit's people picker (#197) — its onDismiss wiring
 * into AnchoredPopover. Mirrors the pattern in lib/overlay-scroll.test.ts and
 * cell-editor-scroll.test.tsx: open the picker for real, let the overlay's
 * arm delay elapse, dispatch a real capture-phase scroll on a node outside
 * it, and assert it closed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ARM_DELAY_MS } from "../lib/overlay-scroll";

vi.mock("../api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/team/members")) {
      return {
        ok: true,
        json: async () => [{ user_id: "u1", name: "Ada Berg", email: "ada@example.com" }],
      } as Response;
    }
    return { ok: true, json: async () => [] } as Response;
  }),
}));

const { Audit } = await import("./Audit");

async function armed(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ARM_DELAY_MS + 20));
  });
}

async function scrollPage(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
}

describe("Audit's people picker closes on scroll", () => {
  it("closes when the page scrolls underneath it", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Audit />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /who/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /who/i }));
    expect(screen.getByPlaceholderText("Find a person…")).toBeInTheDocument();

    await armed();
    await scrollPage();

    expect(screen.queryByPlaceholderText("Find a person…")).not.toBeInTheDocument();
  });

  it("does not close for a scroll before the arm delay elapses", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Audit />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /who/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /who/i }));
    await scrollPage();

    expect(screen.getByPlaceholderText("Find a person…")).toBeInTheDocument();
  });
});
