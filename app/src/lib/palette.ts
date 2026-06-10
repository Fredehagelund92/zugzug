/* palette.ts — curated 10-tint palette used for per-table monograms and per-option
   chips. The hex values live in tokens.css; this file is the typed surface React
   code consumes. Adding a tint = new entry here + matching --tint-* in tokens.css. */

export type PaletteName = "rose" | "amber" | "mint" | "teal" | "indigo" | "violet" | "slate" | "coral" | "sky" | "lime";

export const PALETTE_NAMES: PaletteName[] = [
  "rose",
  "amber",
  "mint",
  "teal",
  "indigo",
  "violet",
  "slate",
  "coral",
  "sky",
  "lime",
];

interface TintEntry {
  /** CSS var reference used as the chip / monogram background. */
  bg: string;
  /** CSS color-mix expression for the chip border / monogram glow. */
  border: string;
  /** CSS color-mix expression for the wash background behind a chip. */
  wash: string;
  /** Foreground color tuned for readability on the wash background (dark theme). */
  fg: string;
}

export const PALETTE: Record<PaletteName, TintEntry> = {
  rose: {
    bg: "var(--tint-rose)",
    border: "color-mix(in srgb,var(--tint-rose) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-rose) 18%,transparent)",
    fg: "var(--tint-rose)",
  },
  amber: {
    bg: "var(--tint-amber)",
    border: "color-mix(in srgb,var(--tint-amber) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-amber) 18%,transparent)",
    fg: "var(--tint-amber)",
  },
  mint: {
    bg: "var(--tint-mint)",
    border: "color-mix(in srgb,var(--tint-mint) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-mint) 18%,transparent)",
    fg: "var(--tint-mint)",
  },
  teal: {
    bg: "var(--tint-teal)",
    border: "color-mix(in srgb,var(--tint-teal) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-teal) 18%,transparent)",
    fg: "var(--tint-teal)",
  },
  indigo: {
    bg: "var(--tint-indigo)",
    border: "color-mix(in srgb,var(--tint-indigo) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-indigo) 18%,transparent)",
    fg: "var(--tint-indigo)",
  },
  violet: {
    bg: "var(--tint-violet)",
    border: "color-mix(in srgb,var(--tint-violet) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-violet) 18%,transparent)",
    fg: "var(--tint-violet)",
  },
  slate: {
    bg: "var(--tint-slate)",
    border: "color-mix(in srgb,var(--tint-slate) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-slate) 18%,transparent)",
    fg: "var(--tint-slate)",
  },
  coral: {
    bg: "var(--tint-coral)",
    border: "color-mix(in srgb,var(--tint-coral) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-coral) 18%,transparent)",
    fg: "var(--tint-coral)",
  },
  sky: {
    bg: "var(--tint-sky)",
    border: "color-mix(in srgb,var(--tint-sky) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-sky) 18%,transparent)",
    fg: "var(--tint-sky)",
  },
  lime: {
    bg: "var(--tint-lime)",
    border: "color-mix(in srgb,var(--tint-lime) 35%,transparent)",
    wash: "color-mix(in srgb,var(--tint-lime) 18%,transparent)",
    fg: "var(--tint-lime)",
  },
};

/** Round-robin a tint based on a stable string (e.g. table id). Used to pick a
 *  default monogram color for a freshly-created table so the picker isn't all
 *  rose. The caller can still override via the swatch picker. */
export function defaultTintFor(seed: string): PaletteName {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE_NAMES[Math.abs(h) % PALETTE_NAMES.length];
}
