/* Where to send someone after they sign in.
 *
 * A deep link opened while signed out is bounced to /login by BootGate. Without
 * carrying the destination the user lands on /app and has to find their way
 * back by hand, so the bounce writes it into `?next=` and the sign-in and
 * sign-up forms read it back.
 *
 * Only a same-origin path is honoured: a full URL or "//host" would turn the
 * sign-in form into an open redirect, and /login or /signup would loop. */

export const RETURN_TO_PARAM = "next";

function isSafe(to: string): boolean {
  if (!to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\")) return false;
  return !/^\/(login|signup)(\/|\?|#|$)/.test(to);
}

/** "/login" for the page the user was trying to reach, with `?next=` when
 *  there is somewhere worth coming back to. */
export function loginUrlWithReturnTo(loc: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  const to = `${loc.pathname}${loc.search}${loc.hash}`;
  if (to === "/" || !isSafe(to)) return "/login";
  return `/login?${RETURN_TO_PARAM}=${encodeURIComponent(to)}`;
}

/** The destination from a "?next=…" query string, or `fallback`. */
export function returnToFrom(search: string, fallback = "/app"): string {
  const raw = new URLSearchParams(search).get(RETURN_TO_PARAM);
  return raw && isSafe(raw) ? raw : fallback;
}
