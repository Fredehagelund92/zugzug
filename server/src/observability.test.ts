import { describe, it, expect, mock, afterEach } from "bun:test";

// Mock the Sentry SDK so no real network/init happens.
const captured: Array<{ e: unknown; opts: unknown }> = [];
let throwOnCapture = false;
mock.module("@sentry/bun", () => ({
  init: mock(() => {}),
  captureException: mock((e: unknown, opts: unknown) => {
    if (throwOnCapture) throw new Error("sentry boom");
    captured.push({ e, opts });
  }),
  flush: mock(async () => true),
}));

import { initSentry, captureError, flushSentry } from "./observability.ts";

afterEach(() => {
  captured.length = 0;
  throwOnCapture = false;
});

describe("observability", () => {
  it("is a no-op when no DSN is configured", () => {
    initSentry(""); // empty DSN → inactive
    expect(() => captureError(new Error("x"), { method: "GET" })).not.toThrow();
    expect(captured).toHaveLength(0);
  });

  it("forwards exceptions with tags once initialized with a DSN", () => {
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0", "test");
    captureError(new Error("boom"), { method: "POST", path: "/api/x" });
    expect(captured).toHaveLength(1);
    expect((captured[0].opts as { tags: Record<string, string> }).tags).toEqual({
      method: "POST",
      path: "/api/x",
    });
  });

  it("swallows errors thrown by the Sentry SDK (telemetry never breaks the caller)", () => {
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0", "test");
    throwOnCapture = true;
    expect(() => captureError(new Error("boom"))).not.toThrow();
  });

  it("flushSentry resolves without throwing", async () => {
    await expect(flushSentry(10)).resolves.toBeUndefined();
  });
});
