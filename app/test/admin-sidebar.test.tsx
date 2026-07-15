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
    for (const label of ["Workspaces", "Users", "Activity", "Warehouse"]) {
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

  test("each sidebar item renders an icon", () => {
    render(
      <MemoryRouter initialEntries={["/app/admin/workspaces"]}>
        <Routes>
          <Route path="/app/admin/*" element={<AdminSidebar />} />
        </Routes>
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation");
    const items = nav.querySelector(".space-y-0\\.5");
    if (!items) throw new Error("Items container not found");
    const links = Array.from(items.querySelectorAll("a"));
    expect(links.length).toBe(4);
    for (const link of links) {
      expect(link.querySelector("svg")).not.toBeNull();
    }
  });
});
