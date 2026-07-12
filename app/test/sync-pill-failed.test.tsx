import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return { ...actual, useSyncStatus: () => "failed" as const };
});

describe("SyncPill", () => {
  test("failed status renders 'Save failed', not 'Saved'", async () => {
    const { SyncPill } = await import("../src/components/SyncPill");
    render(<SyncPill />);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
