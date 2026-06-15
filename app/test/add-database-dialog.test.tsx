import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { AddDatabaseDialog } from "../src/components/warehouse/AddDatabaseDialog";

const apiCalls: Array<{ path: string; init?: RequestInit }> = [];

vi.mock("../src/api", () => ({
  apiFetch: async () => new Response(""),
  authFetch: async (path: string, init?: RequestInit) => {
    apiCalls.push({ path, init });
    if (path === "/warehouse/databases/available") {
      return new Response(
        JSON.stringify([
          { databaseName: "analytics", registered: false },
          { databaseName: "hr", registered: true },
        ]),
      );
    }
    if (path === "/warehouse/databases" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "wd_new" }), { status: 201 });
    }
    return new Response("");
  },
}));

beforeEach(() => {
  apiCalls.length = 0;
});
afterEach(() => {
  cleanup();
});

test("renders the discovered chips after mount", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  expect(document.body.textContent).toContain("analytics");
  expect(document.body.textContent).toContain("hr");
});

test("Add button disabled until manual entry has been probed", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  const addBtn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Add database",
  ) as HTMLButtonElement;
  expect(addBtn.disabled).toBe(true);
});

test("selecting a chip enables Add (already probed by discovery)", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  const chip = document.querySelector('[data-chip="analytics"]') as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(chip);
  });
  const addBtn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Add database",
  ) as HTMLButtonElement;
  expect(addBtn.disabled).toBe(false);
});

test("typing in manual entry deselects chip and resets probe state", async () => {
  await act(async () => {
    render(<AddDatabaseDialog onCancel={vi.fn()} onAdded={vi.fn()} />);
  });
  const chip = document.querySelector('[data-chip="analytics"]') as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(chip);
  });
  expect(chip.className).toContain("border-accent");
  const input = document.querySelector('input[name="databaseName"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.input(input, { target: { value: "other" } });
  });
  // Typing a new name must drop the chip selection and clear any probe banner.
  expect(chip.className).not.toContain("border-accent");
  expect(document.querySelector(".text-danger")).toBeNull();
});
