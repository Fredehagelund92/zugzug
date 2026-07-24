import type { Mode } from "./available-modes";

export const TAB_MODE_KEY = (refTableId: string): string => `zugzug:tab-mode:${refTableId}`;

const isMode = (s: string): s is Mode => s === "records" || s === "match" || s === "sources";

export function readStoredMode(refTableId: string, valid: readonly Mode[]): Mode {
  try {
    const raw = localStorage.getItem(TAB_MODE_KEY(refTableId));
    if (raw && isMode(raw) && valid.includes(raw)) return raw;
  } catch {
    /* localStorage disabled */
  }
  return "records";
}

export function writeStoredMode(refTableId: string, mode: Mode): void {
  try {
    localStorage.setItem(TAB_MODE_KEY(refTableId), mode);
  } catch {
    /* quota / disabled */
  }
}

export function foldUrlMode(
  searchParams: URLSearchParams,
  refTableId: string,
  valid: readonly Mode[],
): Mode {
  const fromUrl = searchParams.get("mode");
  if (fromUrl && isMode(fromUrl) && valid.includes(fromUrl)) return fromUrl;
  return readStoredMode(refTableId, valid);
}
