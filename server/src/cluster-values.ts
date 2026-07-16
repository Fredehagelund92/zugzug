/* cluster-values.ts — deterministic, conservative clustering of scanned source
   values. Values that fold to the SAME normalized key are one cluster; anything
   less certain stays its own cluster (bias to under-cluster). No fuzzy matching
   or aliasing here — that is an opt-in layer built above this module. Pure: no
   I/O, no DB, no env, no React. */

/**
 * Fold a raw value to its conservative cluster key: NFKD-normalize, strip
 * diacritics, lowercase, then drop every non-alphanumeric character. "U.S.A."
 * and "usa" both fold to "usa"; "US" folds to "us" and is kept separate on
 * purpose. A value that folds to the empty string (punctuation-only) gets a
 * unique per-raw key prefixed with NUL so such values never merge together.
 */
export function normalizeKey(raw: string): string {
  const folded = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return folded === "" ? `\u0000${raw}` : folded;
}
