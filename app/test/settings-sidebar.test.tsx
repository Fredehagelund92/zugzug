import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { SettingsSidebar } from "../src/components/settings/SettingsSidebar";

let testRole: "viewer" | "editor" | "admin" = "admin";

function harness(role: "viewer" | "editor" | "admin", path = "/app/acme/settings/general") {
  testRole = role;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/acme/settings" element={<SettingsLayout />}>
          <Route path="general" element={<div>General</div>} />
          <Route path="members" element={<div>Members</div>} />
          <Route path="mapping" element={<div>Mapping</div>} />
          <Route path="warehouse" element={<div>Warehouse</div>} />
          <Route path="tokens" element={<Navigate to="../../integrations/service-accounts" replace />} />
          <Route path="scans" element={<Navigate to="../warehouse#scans" replace />} />
          <Route path="audit" element={<div>Audit</div>} />
          <Route path="danger" element={<div>Danger</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function SettingsLayout() {
  const value: TenantContextValue = {
    id: "t1",
    slug: "acme",
    label: "Acme",
    role: testRole,
    isSuperAdmin: false,
  };
  return (
    <TenantProvider value={value}>
      <SettingsSidebar />
      <Outlet />
    </TenantProvider>
  );
}

const getNavLinks = () => {
  const nav = screen.getByRole("navigation");
  return Array.from(nav.querySelectorAll("a")).map((link) => {
    const spans = link.querySelectorAll("span.font-body");
    const text = spans.length > 0
      ? (spans[spans.length - 1].textContent?.trim() || "")
      : (link.textContent?.trim() || "");
    return {
      text,
      ariaCurrent: link.getAttribute("aria-current"),
    };
  });
};

describe("SettingsSidebar", () => {
  test("renders the five workspace settings sections", () => {
    harness("admin");
    const links = getNavLinks();
    const texts = links.map((l) => l.text);
    expect(texts).toEqual(["General", "Members", "Mapping", "Warehouse", "Danger"]);
  });

  test("active route gets aria-current", () => {
    harness("admin", "/app/acme/settings/members");
    const links = getNavLinks();
    const membersLink = links.find((l) => l.text === "Members");
    expect(membersLink?.ariaCurrent).toBe("page");
  });

  test("each sidebar item renders an icon", () => {
    harness("admin");
    const nav = screen.getByRole("navigation");
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.length).toBe(5);
    for (const link of links) {
      expect(link.querySelector("svg")).not.toBeNull();
    }
  });
});
