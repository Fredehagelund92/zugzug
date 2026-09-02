/**
 * pushState never triggers the browser's own "#fragment" scrolling, so the
 * settings/scans → warehouse#scans redirect used to land at the top of a long
 * page. Covers: app/src/components/HashScroll.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HashScroll } from "../src/components/HashScroll";

describe("HashScroll", () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it("scrolls the fragment's target into view", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/settings/warehouse#scans"]}>
        <HashScroll />
        <div id="scans">Scans</div>
      </MemoryRouter>,
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("does nothing without a fragment", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/settings/warehouse"]}>
        <HashScroll />
        <div id="scans">Scans</div>
      </MemoryRouter>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does nothing when the fragment names no element on the page", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/settings/warehouse#nope"]}>
        <HashScroll />
        <div id="scans">Scans</div>
      </MemoryRouter>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
