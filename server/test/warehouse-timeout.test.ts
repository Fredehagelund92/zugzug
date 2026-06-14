import { test, expect } from "bun:test";
import { withTimeout, TimeoutError } from "../src/warehouse/timeout.ts";

test("resolves when work finishes before deadline", async () => {
  const out = await withTimeout(() => Promise.resolve("ok"), 100, "test");
  expect(out).toBe("ok");
});

test("rejects with TimeoutError when work exceeds deadline", async () => {
  const slow = (): Promise<string> => new Promise((res) => setTimeout(() => res("late"), 500));
  await expect(withTimeout(slow, 50, "test")).rejects.toBeInstanceOf(TimeoutError);
});

test("TimeoutError exposes the operation name", async () => {
  const slow = (): Promise<string> => new Promise(() => {});
  try {
    await withTimeout(slow, 20, "listDatabases");
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).operation).toBe("listDatabases");
  }
});
