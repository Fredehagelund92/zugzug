/**
 * The Review page moved from /app/:slug/triage to /app/:slug/review ("triage"
 * is banned vocabulary and the path is visible in the address bar and in any
 * shared link). Bookmarks and links already out there must keep working, so
 * the old path stays as a redirect.
 *
 * Covers: app/src/main.tsx (per-tenant shell routes)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";

const MAIN = readFileSync(join(__dirname, "../src/main.tsx"), "utf8");

function Stub({ name }: { name: string }) {
  return <div data-testid="page">{name}</div>;
}

describe("Review route", () => {
  it("main.tsx serves the page at review and keeps triage as a redirect", () => {
    expect(MAIN).toContain('<Route path="review" element={<Triage />} />');
    expect(MAIN).toContain('<Route path="triage" element={<Navigate to="../review" replace />} />');
  });

  it("the old triage path lands on the Review page", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/triage"]}>
        <Routes>
          {/* main.tsx's per-tenant shell: splat route, then a pathless layout. */}
          <Route path="/app/:tenantSlug/*" element={<Outlet />}>
            <Route element={<Outlet />}>
              <Route path="review" element={<Stub name="review" />} />
              <Route path="triage" element={<Navigate to="../review" replace />} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("page").textContent).toBe("review");
  });
});
