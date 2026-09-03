import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { setMemberships } from "../src/store";
import { LAST_SLUG_KEY } from "../src/lib/tenant-storage";
import { AdminLayout } from "../src/components/admin/AdminLayout";

vi.mock("../src/api", () => ({ authFetch: vi.fn(async () => new Response("")) }));

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={["/app/admin/workspaces"]}>
      <Routes>
        <Route path="/app/admin/*" element={<AdminLayout />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdminLayout header", () => {
  beforeEach(() => {
    localStorage.clear();
    setMemberships([]);
  });

  // The admin console had neither, so a super-admin had to navigate into a
  // workspace to sign out or reach their account.
  test("offers sign-out, and Account once a workspace is known", () => {
    setMemberships([{ slug: "acme", label: "Acme", role: "admin", color: null, capabilities: [] }]);
    localStorage.setItem(LAST_SLUG_KEY, "acme");
    renderAdmin();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^account$/i }).getAttribute("href")).toBe(
      "/app/acme/account/profile",
    );
  });

  test("with no workspace to enter, sign-out still shows and Account is omitted", () => {
    renderAdmin();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^account$/i })).toBeNull();
  });
});
