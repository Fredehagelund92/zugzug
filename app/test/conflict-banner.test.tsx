import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConflictBanner } from "../src/components/ConflictBanner";

describe("ConflictBanner", () => {
  const conflict = {
    updatedBy: { id: "u_mia", name: "Mia Berg", initials: "MB" },
    updatedAt: new Date(Date.now() - 12_000).toISOString(),
  };

  test("renders the updater's name and 'ago' time", () => {
    render(
      <ConflictBanner
        conflict={conflict}
        onRefresh={() => undefined}
        onKeepEditing={() => undefined}
      />,
    );
    expect(screen.getByText(/mia berg/i)).toBeInTheDocument();
    expect(screen.getByText(/\d+s ago/i)).toBeInTheDocument();
    expect(screen.getByText(/your changes weren't saved/i)).toBeInTheDocument();
  });

  test("clicking Refresh fires onRefresh", async () => {
    const onRefresh = vi.fn();
    render(
      <ConflictBanner conflict={conflict} onRefresh={onRefresh} onKeepEditing={() => undefined} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /use theirs/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  test("clicking Keep editing fires onKeepEditing", async () => {
    const onKeepEditing = vi.fn();
    render(
      <ConflictBanner
        conflict={conflict}
        onRefresh={() => undefined}
        onKeepEditing={onKeepEditing}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /keep my version/i }));
    expect(onKeepEditing).toHaveBeenCalledOnce();
  });

  test("conflictedKeys = ['Norway', 'Sweden'] surfaces 'Norway (and 1 other)'", () => {
    render(
      <ConflictBanner
        conflict={conflict}
        conflictedKeys={["Norway", "Sweden"]}
        onRefresh={() => undefined}
        onKeepEditing={() => undefined}
      />,
    );
    expect(screen.getByText(/norway/i)).toBeInTheDocument();
    expect(screen.getByText(/and 1 other/i)).toBeInTheDocument();
  });

  test("renders theirs-vs-yours lines when a diff is provided", () => {
    const diff = [{ field: "label", theirs: "ACME Inc", yours: "ACME Inc." }];
    render(
      <ConflictBanner
        conflict={conflict}
        diff={diff}
        onRefresh={() => undefined}
        onKeepEditing={() => undefined}
      />,
    );
    expect(screen.getByText(/label:/)).toBeInTheDocument();
    expect(screen.getByText(/theirs "ACME Inc"/)).toBeInTheDocument();
    expect(screen.getByText(/yours "ACME Inc\."/)).toBeInTheDocument();

    // Assert list does not render when diff is omitted
    const { container: containerWithoutDiff } = render(
      <ConflictBanner
        conflict={conflict}
        onRefresh={() => undefined}
        onKeepEditing={() => undefined}
      />,
    );
    expect(containerWithoutDiff.querySelector("ul")).not.toBeInTheDocument();
  });
});
