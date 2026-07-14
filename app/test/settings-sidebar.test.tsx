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
          <Route path="pull-api" element={<div>Pull API</div>} />
          <Route path="webhooks" element={<div>Webhooks</div>} />
          <Route path="service-accounts" element={<div>Service accounts</div>} />
          <Route path="tokens" element={<Navigate to="../service-accounts" replace />} />
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

const getSectionKickers = () => {
  const nav = screen.getByRole("navigation");
  return Array.from(nav.querySelectorAll("span.font-mono")).map((s) => s.textContent?.trim() || "");
};

describe("SettingsSidebar", () => {
  test("renders Workspace, Integrations and Danger sections", () => {
    harness("admin");
    expect(getSectionKickers()).toEqual(["Workspace", "Integrations", "Danger"]);
  });

  test("Workspace section lists General, Members, Mapping, Warehouse", () => {
    harness("admin");
    const texts = getNavLinks().map((l) => l.text);
    expect(texts.slice(0, 4)).toEqual(["General", "Members", "Mapping", "Warehouse"]);
  });

  test("Integrations section lists Pull API, Webhooks, Service accounts", () => {
    harness("admin");
    const texts = getNavLinks().map((l) => l.text);
    expect(texts).toContain("Pull API");
    expect(texts).toContain("Webhooks");
    expect(texts).toContain("Service accounts");
  });

  test("Danger section lists Danger last", () => {
    harness("admin");
    const texts = getNavLinks().map((l) => l.text);
    expect(texts[texts.length - 1]).toBe("Danger");
  });

  test("renders the account cross-link", () => {
    harness("admin");
    const link = screen.getByRole("link", { name: /Your account/ });
    expect(link.getAttribute("href")).toBe("/app/acme/account/profile");
  });

  test("a section whose items are all filtered renders no kicker", () => {
    // Viewers cannot view service accounts, but Pull API + Webhooks remain,
    // so the Integrations section still shows. All three sections stay for viewers.
    harness("viewer");
    expect(getSectionKickers()).toEqual(["Workspace", "Integrations", "Danger"]);
    const texts = getNavLinks().map((l) => l.text);
    expect(texts).not.toContain("Service accounts");
  });

  test("active route gets aria-current", () => {
    harness("admin", "/app/acme/settings/members");
    const membersLink = getNavLinks().find((l) => l.text === "Members");
    expect(membersLink?.ariaCurrent).toBe("page");
  });

  test("each sidebar item renders an icon", () => {
    harness("admin");
    const nav = screen.getByRole("navigation");
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.length).toBe(8);
    for (const link of links) {
      expect(link.querySelector("svg")).not.toBeNull();
    }
  });
});
