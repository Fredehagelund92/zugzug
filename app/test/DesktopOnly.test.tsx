import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesktopOnly } from "../src/components/DesktopOnly";

function setViewport(isNarrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: isNarrow,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("DesktopOnly", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("passes clicks through on a wide screen", async () => {
    setViewport(false);
    const onClick = vi.fn();
    render(
      <DesktopOnly reason="Open on a larger screen to add a source.">
        <button onClick={onClick}>Add source</button>
      </DesktopOnly>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("blocks the click and explains why on a narrow screen", async () => {
    setViewport(true);
    const onClick = vi.fn();
    render(
      <DesktopOnly reason="Open on a larger screen to add a source.">
        <button onClick={onClick}>Add source</button>
      </DesktopOnly>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(onClick).not.toHaveBeenCalled();
    expect(
      screen.getByText("Open on a larger screen to add a source."),
    ).toBeInTheDocument();
  });

  it("keeps the control visible on a narrow screen", () => {
    setViewport(true);
    render(
      <DesktopOnly reason="Open on a larger screen to add a source.">
        <button>Add source</button>
      </DesktopOnly>,
    );
    expect(screen.getByRole("button", { name: "Add source" })).toBeVisible();
  });
});
