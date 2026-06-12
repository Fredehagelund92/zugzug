import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
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
          <Route path="tokens" element={<div>Tokens</div>} />
          <Route path="scans" element={<div>Scans</div>} />
          <Route path="matching" element={<div>Matching</div>} />
          <Route path="warehouse" element={<div>Warehouse</div>} />
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
    // The label text lives in the last <span> child (after the counter span).
    // Fall back to full textContent for forward-compatibility.
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
  test("viewer does NOT see Tokens", () => {
    harness("viewer");
    const links = getNavLinks();
    const texts = links.map((l) => l.text);
    expect(texts.includes("General")).toBeTruthy();
    expect(texts.includes("Members")).toBeTruthy();
    expect(texts.includes("Tokens")).toBeFalsy();
  });

  test("editor sees Tokens", () => {
    harness("editor");
    const links = getNavLinks();
    const texts = links.map((l) => l.text);
    expect(texts.includes("Tokens")).toBeTruthy();
  });

  test("admin sees every section", () => {
    harness("admin");
    const links = getNavLinks();
    const texts = links.map((l) => l.text);
    for (const label of ["General", "Members", "Tokens", "Scans", "Matching", "Warehouse", "Audit", "Danger"]) {
      expect(texts.includes(label)).toBeTruthy();
    }
  });

  test("active route gets aria-current", () => {
    harness("admin", "/app/acme/settings/members");
    const links = getNavLinks();
    const membersLink = links.find((l) => l.text === "Members");
    expect(membersLink?.ariaCurrent).toBe("page");
  });
});
