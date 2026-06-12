import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AdminSidebar } from "../src/components/admin/AdminSidebar";

describe("AdminSidebar", () => {
  test("renders all four sections", () => {
    render(
      <MemoryRouter initialEntries={["/app/admin/workspaces"]}>
        <Routes>
          <Route path="/app/admin/*" element={<AdminSidebar />} />
        </Routes>
      </MemoryRouter>,
    );
    for (const label of ["Workspaces", "Users", "Audit", "Warehouses"]) {
      expect(screen.getByText(new RegExp(`^${label}$`, "i"))).toBeTruthy();
    }
  });

  test("shows System group label", () => {
    render(
      <MemoryRouter initialEntries={["/app/admin/workspaces"]}>
        <Routes>
          <Route path="/app/admin/*" element={<AdminSidebar />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/^system$/i)).toBeTruthy();
  });
});
