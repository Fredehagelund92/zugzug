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
    // A malformed escape ("#%") makes decodeURIComponent throw, and an
    // exception from a root-level effect unmounts the whole app — so a crafted
    // link would blank the page. Fall back to the fragment as written.
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      id = hash.slice(1);
    }
    document.getElementById(id)?.scrollIntoView();
  }, [hash]);
  return null;
}
