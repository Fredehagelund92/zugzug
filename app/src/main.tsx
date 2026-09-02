import React from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./globals.css";
import { setAccent, setTheme, toggleTheme } from "./theme";
import { BootGate, AppIndex } from "./components/BootGate";
import { AppShell } from "./components/AppShell";
import { AdminLayout } from "./components/admin/AdminLayout";
import { TenantLayout } from "./components/TenantLayout";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { Login } from "./routes/Login";
import { Signup } from "./routes/Signup";
import { Dashboard } from "./routes/Dashboard";
import { Triage } from "./routes/Triage";
import { Sources } from "./routes/Sources";
import { MasterTables } from "./routes/MasterTables";
import { SettingsLayout } from "./components/settings/SettingsLayout";
import { General } from "./routes/settings/General";
import { Members } from "./routes/settings/Members";
import { Matching } from "./routes/settings/Matching";
import { Warehouse } from "./routes/settings/Warehouse";
import { Audit } from "./routes/Audit";
import { Danger } from "./routes/settings/Danger";
import { Showcase } from "./routes/Showcase";
import { Workspaces } from "./routes/admin/Workspaces";
import { Users as AdminUsers } from "./routes/admin/Users";
import { Audit as AdminAudit } from "./routes/admin/Audit";
import { Warehouses as AdminWarehouses } from "./routes/admin/Warehouses";
import { WebhookDetailRedirect } from "./routes/integrations/WebhookDetailRedirect";
import { PullApi } from "./routes/integrations/PullApi";
import { Webhooks } from "./routes/integrations/Webhooks";
import { WebhookDetail } from "./routes/integrations/WebhookDetail";
import { ServiceAccounts } from "./routes/integrations/ServiceAccounts";
import { Account } from "./routes/account/Account";
import { Profile } from "./routes/account/Profile";
import { Memberships } from "./routes/account/Memberships";

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
  });
}

declare global {
  interface Window {
    BrandApp?: {
      setAccent: typeof setAccent;
      setTheme: typeof setTheme;
      toggleTheme: typeof toggleTheme;
    };
  }
}
if (import.meta.env.DEV) {
  window.BrandApp = { setAccent, setTheme, toggleTheme };
}

const root = document.getElementById("root")!;

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Public — no session required */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/design" element={<Showcase />} />

        {/* Protected — BootGate checks /api/auth/me and redirects to /login on 401 */}
        <Route
          path="*"
          element={
            <RouteErrorBoundary>
              <BootGate>
                {(boot) => (
                  <Routes>
                    {/* "/" funnels into "/app"; AppIndex is the single place
                        that decides which workspace that resolves to. */}
                    <Route path="/" element={<Navigate to="/app" replace />} />
                    <Route path="/app" element={<AppIndex isSuperAdmin={boot.isSuperAdmin} />} />

                    {/* Super-admin shell */}
                    {boot.isSuperAdmin ? (
                      <Route path="/app/admin/*" element={<AdminLayout />}>
                        <Route index element={<Navigate to="workspaces" replace />} />
                        <Route path="workspaces" element={<Workspaces />} />
                        <Route path="users" element={<AdminUsers />} />
                        <Route path="audit" element={<AdminAudit />} />
                        <Route path="warehouse" element={<AdminWarehouses />} />
                      </Route>
                    ) : null}

                    {/* Per-tenant shell — TenantLayout validates slug, drives session lifecycle */}
                    <Route
                      path="/app/:tenantSlug/*"
                      element={<TenantLayout isSuperAdmin={boot.isSuperAdmin} />}
                    >
                      <Route element={<AppShell />}>
                        <Route index element={<Dashboard />} />
                        <Route path="review" element={<Triage />} />
                        <Route path="triage" element={<Navigate to="../review" replace />} />
                        <Route path="sources" element={<Sources />} />
                        <Route path="tables" element={<MasterTables />} />
                        <Route path="audit" element={<Audit />} />
                        <Route path="settings" element={<SettingsLayout />}>
                          <Route index element={<Navigate to="general" replace />} />
                          <Route path="general" element={<General />} />
                          <Route path="members" element={<Members />} />
                          <Route
                            path="tokens"
                            element={<Navigate to="../service-accounts" replace />}
                          />
                          <Route
                            path="scans"
                            element={<Navigate to="../warehouse#scans" replace />}
                          />
                          <Route path="mapping" element={<Matching />} />
                          <Route path="matching" element={<Navigate to="../mapping" replace />} />
                          <Route path="warehouse" element={<Warehouse />} />
                          <Route path="danger" element={<Danger />} />
                          <Route path="pull-api" element={<PullApi />} />
                          <Route path="webhooks" element={<Webhooks />} />
                          <Route path="webhooks/:id" element={<WebhookDetail />} />
                          <Route path="service-accounts" element={<ServiceAccounts />} />
                        </Route>
                        <Route path="integrations">
                          <Route index element={<Navigate to="../settings/pull-api" replace />} />
                          <Route
                            path="pull-api"
                            element={<Navigate to="../../settings/pull-api" replace />}
                          />
                          <Route
                            path="webhooks"
                            element={<Navigate to="../../settings/webhooks" replace />}
                          />
                          <Route path="webhooks/:id" element={<WebhookDetailRedirect />} />
                          <Route
                            path="service-accounts"
                            element={<Navigate to="../../settings/service-accounts" replace />}
                          />
                        </Route>
                        <Route path="account" element={<Account />}>
                          <Route index element={<Navigate to="profile" replace />} />
                          <Route path="profile" element={<Profile />} />
                          <Route path="memberships" element={<Memberships />} />
                          <Route
                            path="notifications"
                            element={<Navigate to="../memberships" replace />}
                          />
                        </Route>
                      </Route>
                    </Route>

                    <Route path="*" element={<Navigate to="/app" replace />} />
                  </Routes>
                )}
              </BootGate>
            </RouteErrorBoundary>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
