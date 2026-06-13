import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { Memberships } from "../src/routes/account/Memberships";
import type { Membership } from "../src/components/TenantLayout";

const MEMBERSHIPS: Membership[] = [
  { slug: "sportsbook", label: "Sportsbook", role: "admin" },
  { slug: "media", label: "Media", role: "editor" },
];

function harness(memberships: Membership[]) {
  return render(
    <MemoryRouter initialEntries={["/account/memberships"]}>
      <Routes>
        <Route path="/account" element={<Outlet context={{ memberships }} />}>
          <Route path="memberships" element={<Memberships />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Account/Memberships", () => {
  it("lists every workspace with role and Leave button", () => {
    harness(MEMBERSHIPS);
    expect(screen.getByText("Sportsbook")).toBeInTheDocument();
    expect(screen.getByText("Media")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Leave" })).toHaveLength(2);
  });

  it("opens a confirm dialog when Leave is clicked", () => {
    harness(MEMBERSHIPS);
    fireEvent.click(screen.getAllByRole("button", { name: "Leave" })[0]!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Leave Sportsbook\?/)).toBeInTheDocument();
  });

  it("shows EmptyState when memberships array is empty", () => {
    harness([]);
    expect(screen.getByText("No memberships yet")).toBeInTheDocument();
  });
});
