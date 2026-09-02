import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Scroll to the "#id" in the URL after a client-side navigation.
 *  pushState never triggers the browser's own fragment scrolling, so a link
 *  (or redirect) to `settings/warehouse#scans` otherwise lands at the top of
 *  the page. Renders nothing. */
export function HashScroll() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);
  return null;
}
