import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { RemoveDatabaseConfirm } from "../src/components/warehouse/RemoveDatabaseConfirm";
import type { DatabaseRow } from "../src/components/warehouse/DatabaseTable";

const apiCalls: Array<{ path: string; init?: RequestInit }> = [];
const responses: Array<(path: string, init?: RequestInit) => Response> = [];

vi.mock("../src/api", () => ({
  apiFetch: async () => new Response(null, { status: 204 }),
  authFetch: async (path: string, init?: RequestInit) => {
    apiCalls.push({ path, init });
    const next = responses.shift();
    if (next) return next(path, init);
    return new Response(null, { status: 204 });
  },
}));

const sample: DatabaseRow = {
  id: "wd_demo",
  databaseName: "analytics",
  label: null,
  addedAt: new Date().toISOString(),
  sourceCount: 0,
  lastProbeAt: null,
  lastProbeError: null,
};

beforeEach(() => {
  apiCalls.length = 0;
  responses.length = 0;
});
afterEach(() => {
  cleanup();
});

test("204 on first delete resolves without confirmation", async () => {
  const onRemoved = vi.fn();
  responses.push(() => new Response(null, { status: 204 }));
  await act(async () => {
    render(<RemoveDatabaseConfirm database={sample} onCancel={vi.fn()} onRemoved={onRemoved} />);
  });
  expect(onRemoved).toHaveBeenCalled();
  expect(apiCalls[0]?.path).toBe("/warehouse/databases/wd_demo");
});

test("409 surfaces dependency list and unlocks force button via ack", async () => {
  responses.push(
    () =>
      new Response(
        JSON.stringify({
          kind: "DATABASE_IN_USE",
          sourceCount: 3,
          dimensions: [{ dimId: "country", sources: ["public.users.country", "public.orders.country"] }],
        }),
        { status: 409 },
      ),
  );
  await act(async () => {
    render(<RemoveDatabaseConfirm database={sample} onCancel={vi.fn()} onRemoved={vi.fn()} />);
  });
  // dependency text rendered
  expect(document.body.textContent).toContain("3 sources");
  expect(document.body.textContent).toContain("country");
  // force button disabled until ack
  const force = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Remove and unbind sources",
  ) as HTMLButtonElement;
  expect(force.disabled).toBe(true);
  // tick the ack checkbox
  const ack = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.click(ack);
  });
  expect(force.disabled).toBe(false);
});

test("409 dependency body uses plain-language copy (tables/records, not dimensions/canonical)", async () => {
  responses.push(
    () =>
      new Response(
        JSON.stringify({
          kind: "DATABASE_IN_USE",
          sourceCount: 2,
          dimensions: [{ dimId: "region", sources: ["public.orders.region"] }],
        }),
        { status: 409 },
      ),
  );
  await act(async () => {
    render(<RemoveDatabaseConfirm database={sample} onCancel={vi.fn()} onRemoved={vi.fn()} />);
  });
  const body = document.body.textContent ?? "";
  expect(body).toContain("tables");
  expect(body).toContain("records");
  expect(body).not.toContain("dimensions");
  expect(body).not.toContain("Canonical");
});

test("force delete posts ?force=true and resolves on 204", async () => {
  const onRemoved = vi.fn();
  responses.push(
    () =>
      new Response(
        JSON.stringify({
          kind: "DATABASE_IN_USE",
          sourceCount: 1,
          dimensions: [{ dimId: "country", sources: ["x"] }],
        }),
        { status: 409 },
      ),
    () => new Response(null, { status: 204 }),
  );
  await act(async () => {
    render(<RemoveDatabaseConfirm database={sample} onCancel={vi.fn()} onRemoved={onRemoved} />);
  });
  const ack = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.click(ack);
  });
  const force = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Remove and unbind sources",
  ) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(force);
  });
  expect(apiCalls[1]?.path).toBe("/warehouse/databases/wd_demo?force=true");
  expect(onRemoved).toHaveBeenCalled();
});
