/* use-presence-color.ts — deterministic userId → palette tint mapping.
 * Used for color-coding peer presence (cursors, avatars). djb2-style hash
 * keeps the output stable across reloads, so the same user always gets
 * the same color for everyone watching. */

import { PALETTE_NAMES, type PaletteName } from "./palette";

export function presenceColorFor(userId: string): PaletteName {
  let hash = 5381;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) + hash + userId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE_NAMES.length;
  return PALETTE_NAMES[idx]!;
}
