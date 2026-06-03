/* bucket.ts — deterministic palette-bucket assignment for single-select chips.
   Same label → same bucket, always. 5 buckets drawn from the existing palette
   tokens (ok/warn/accent/accent-2/neutral) so chips never introduce new colors. */

export const BUCKETS = ["chip-1", "chip-2", "chip-3", "chip-4", "chip-5"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** FNV-1a 32-bit hash. Stable across runs and platforms. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function bucket(label: string): Bucket {
  return BUCKETS[hash32(label.toLowerCase()) % BUCKETS.length];
}
