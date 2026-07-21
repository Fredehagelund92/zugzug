/* server-observability.test.ts — source-guard test asserting that captureError
   is called only in the non-AppError branches of server.ts request catches.

   Why a source-guard rather than a behavioral test: the request-catch blocks in
   server.ts live inside Bun.serve's fetch handler or behind session/admin gates
   that require a live database + full session scaffold. Driving them from a unit
   test would require the entire server stack. Instead we read the source and
   assert that the branch structure is correct — the same pattern used for the
   cross-path first-admin invariant in auth.test.ts. */

import { describe, it, expect } from "bun:test";

describe("server.ts observability call-site filtering", () => {
  it("captureError appears only in the non-AppError branch of each request catch", async () => {
    const src = await Bun.file("src/server.ts").text();

    // Find all catch blocks that contain both `instanceof AppError` and `captureError`.
    // Split on catch blocks so we can inspect them individually.
    // Strategy: assert that every occurrence of `captureError(` in the file is
    // preceded (within the same catch block) by an `instanceof AppError` guard
    // that returns early — i.e. `captureError` never appears inside an
    // `if (e instanceof AppError)` branch.

    // 1. captureError must appear in server.ts (wired)
    expect(src).toContain("captureError(");

    // 2. captureError must NOT appear inside an `if (e instanceof AppError)` block.
    //    We detect this by finding every `if (e instanceof AppError) {` block
    //    (up to the closing `}`) and asserting none of them contain `captureError`.
    const appErrorBlockRe = /if\s*\(\s*e\s+instanceof\s+AppError\s*\)[\s\S]*?\n\s*\}/g;
    const appErrorBlocks = [...src.matchAll(appErrorBlockRe)].map((m) => m[0]);
    expect(appErrorBlocks.length).toBeGreaterThan(0); // guard: the filter check must actually have blocks to check
    for (const block of appErrorBlocks) {
      expect(block).not.toContain("captureError(");
    }

    // 3. Each request-catch that logs `✗ ${method}` must also call captureError.
    //    The warehouse-ping `✗ warehouse adapter ping failed` is not a request
    //    catch (it exits the process) so we count only the method-interpolated form.
    const requestLogCount = (src.match(/console\.error\(`✗ \$\{.*method/g) ?? []).length;
    const captureCount = (src.match(/captureError\(e, \{ method/g) ?? []).length;
    // There are 3 request-handler `✗ ${method}` log sites:
    //   handle() admin catch, handleTenantRequest() catch, Bun.serve fetch catch.
    // Each must have a paired captureError call.
    expect(requestLogCount).toBeGreaterThanOrEqual(1);
    expect(captureCount).toBe(requestLogCount);
  });
});
