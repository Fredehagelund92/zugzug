import { describe, test, expect, beforeAll, afterEach, afterAll } from "vitest";
import { server } from "./server.ts";
import { apiFetch } from "../../src/api.ts";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("MSW intercepts the app API client", () => {
  test("apiFetch('/dimensions') hits the /api/t/:slug/ handler", async () => {
    // apiFetch derives the slug from the pathname and rewrites the URL.
    window.history.pushState({}, "", "/app/acme/tables");
    const res = await apiFetch("/dimensions");
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { id: string }[];
    expect(body[0]?.id).toBe("d1");
  });
});
