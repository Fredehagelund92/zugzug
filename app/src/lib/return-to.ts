/* Where to send someone after they sign in.
 *
 * A deep link opened while signed out is bounced to /login by BootGate. Without
 * carrying the destination the user lands on /app and has to find their way
 * back by hand, so the bounce writes it into `?next=` and the sign-in and
 * sign-up forms read it back.
 *
 * Only a same-origin path is honoured, or the sign-in form becomes an open
 * redirect. */

export const RETURN_TO_PARAM = "next";

/* Resolved against a sentinel origin rather than checked with string prefixes.
 * Browsers strip tab, newline and carriage return before resolving a URL, so
 * "/\t/evil.com" slips past a startsWith("//") test and then loads
 * //evil.com — an open redirect. Anything that does not resolve back to the
 * sentinel came from somewhere else and is refused. */
const SENTINEL = "https://return-to.invalid";

/** The same-origin path to honour, or null if `to` is not one. Returns the
 *  NORMALIZED path so callers use the string that was actually validated. */
function safePath(to: string): string | null {
  let u: URL;
  try {
    u = new URL(to, SENTINEL);
  } catch {
    return null;
  }
  if (u.origin !== SENTINEL) return null;
  // /login and /signup would bounce the user straight back here.
  if (/^\/(login|signup)(\/|$)/.test(u.pathname)) return null;
  const path = `${u.pathname}${u.search}${u.hash}`;
  return path === "/" ? null : path;
}

/** "/login" for the page the user was trying to reach, with `?next=` when
 *  there is somewhere worth coming back to. */
export function loginUrlWithReturnTo(loc: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  const to = safePath(`${loc.pathname}${loc.search}${loc.hash}`);
  return to ? `/login?${RETURN_TO_PARAM}=${encodeURIComponent(to)}` : "/login";
}

/** The destination from a "?next=…" query string, or `fallback`. */
export function returnToFrom(search: string, fallback = "/app"): string {
  const raw = new URLSearchParams(search).get(RETURN_TO_PARAM);
  return (raw && safePath(raw)) || fallback;
}
