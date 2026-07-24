import { test, expect, vi, beforeEach } from "vitest";

/**
 * The `api` helper used by store actions is module-local to store.ts; under the
 * hood it calls `apiFetch` from ../src/api.  Mocking apiFetch is the right seam
 * to capture PATCH bodies without re-implementing the whole store import graph.
 *
 * Each test asserts on calls[0] (the PATCH); a follow-up GET from refreshDim()
 * may also land in the spy but is irrelevant to the contract being verified.
 */

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];

vi.mock("../src/api", () => ({
  // Return a Response-like object that the store's `api` helper treats as 204
  // (so refreshDim's MappingRefTable parse path is short-circuited).
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(null, { status: 204 });
  }),
  authFetch: vi.fn(async () => new Response(null, { status: 204 })),
}));

// Defensive: tenant-context is imported at the top of store.ts; the hook itself
// is only invoked from inside React components, so plain-async store actions
// don't actually need it.  Stubbing keeps the import graph small.
vi.mock("../src/lib/tenant-context", () => ({
  useTenantOptional: () => null,
}));

import { updateFieldDisplayFields } from "../src/store";

beforeEach(() => {
  calls.length = 0;
});

test("updateFieldDisplayFields PATCHes the field with stringified field_config", async () => {
  await updateFieldDisplayFields("partner", "country", ["label", "iso_code", "region"]);
  const patch = calls.find((c) => c.init?.method === "PATCH");
  expect(patch).toBeDefined();
  expect(patch!.path).toBe("/tables/partner/fields/country");
  const body = JSON.parse(String(patch!.init?.body));
  const cfg = JSON.parse(body.field_config);
  expect(cfg.displayFields).toEqual(["label", "iso_code", "region"]);
});

test("encodes refTable and field params for URL safety", async () => {
  await updateFieldDisplayFields("refTable with space", "f/k", ["label"]);
  const patch = calls.find((c) => c.init?.method === "PATCH");
  expect(patch!.path).toBe("/tables/refTable%20with%20space/fields/f%2Fk");
});
