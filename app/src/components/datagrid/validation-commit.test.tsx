import { describe, it, expect, vi } from "vitest";
import { renderGrid } from "./test-kit/render-grid";

describe("value-shape enforcement at commit", () => {
  it("suppresses the write and reports the message for an invalid value", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onInvalid = vi.fn();
    const validate = (_f: string, v: unknown) => (Number(v) < 0 ? "Must be 0 or more." : null);

    const g = renderGrid({
      onCommit,
      validate,
      onInvalidCommit: onInvalid,
    });

    await g.editCell(0, "count", "-5");

    expect(onCommit).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledWith(expect.any(String), "count", "Must be 0 or more.");
  });

  it("commits a valid value normally", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onInvalid = vi.fn();
    const validate = (_f: string, v: unknown) => (Number(v) < 0 ? "Must be 0 or more." : null);

    const g = renderGrid({
      onCommit,
      validate,
      onInvalidCommit: onInvalid,
    });

    await g.editCell(0, "count", "42");

    expect(onCommit).toHaveBeenCalledWith(expect.any(String), "count", 42);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});
