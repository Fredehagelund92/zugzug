import { describe, it, expect } from "bun:test";
import { PALETTE_NAMES as SERVER_PALETTE } from "./repo-shared.ts";
import { PALETTE_NAMES as CLIENT_PALETTE } from "../../app/src/lib/palette.ts";

/* The palette name list is duplicated on purpose: the client owns the tints (they
   map to --tint-* CSS tokens) and the server keeps its own copy to validate inbound
   colors without importing a client module. That duplication once drifted — the
   client gained coral/sky/lime, the server didn't, and creating a table whose
   default tint landed on a missing color failed with "unknown color: lime". This
   test fails loudly the next time the two lists diverge. Keep them in sync by
   editing app/src/lib/palette.ts and server/src/repo-shared.ts together. */
describe("palette name lists stay in sync across client and server", () => {
  it("server accepts exactly the colors the client can send", () => {
    expect([...SERVER_PALETTE].sort()).toEqual([...CLIENT_PALETTE].sort());
  });
});
