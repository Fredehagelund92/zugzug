/** localStorage key holding the slug of the workspace the user was last in.
 *  Written by TenantLayout on every workspace entry, read by AppIndex to pick
 *  where "/app" lands. */
export const LAST_SLUG_KEY = "zugzug:last-tenant-slug";

export function scopedKey(base: string, slug: string): string {
  return `${base}:${slug}`;
}
