import type { Mode } from "./available-modes";

export const TAB_MODE_KEY = (dimId: string): string => `zugzug:tab-mode:${dimId}`;

const isMode = (s: string): s is Mode => s === "records" || s === "match" || s === "sources";

export function readStoredMode(dimId: string, valid: readonly Mode[]): Mode {
  try {
    const raw = localStorage.getItem(TAB_MODE_KEY(dimId));
    if (raw && isMode(raw) && valid.includes(raw)) return raw;
  } catch {
    /* localStorage disabled */
  }
  return "records";
}

export function writeStoredMode(dimId: string, mode: Mode): void {
  try {
    localStorage.setItem(TAB_MODE_KEY(dimId), mode);
  } catch {
    /* quota / disabled */
  }
}

export function foldUrlMode(
  searchParams: URLSearchParams,
  dimId: string,
  valid: readonly Mode[],
): Mode {
  const fromUrl = searchParams.get("mode");
  if (fromUrl && isMode(fromUrl) && valid.includes(fromUrl)) return fromUrl;
  return readStoredMode(dimId, valid);
}
