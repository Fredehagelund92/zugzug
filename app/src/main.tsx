import React from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./globals.css";
import { setAccent, setTheme, toggleTheme } from "./theme";
import { EngineerModeProvider } from "./lib/engineer-mode";
import { OpenTabsProvider } from "./lib/open-tabs";
import { CreateTableModalProvider } from "./lib/create-table-modal";
import { BootGate } from "./components/BootGate";
import { AppShell } from "./components/AppShell";
import { AdminShell } from "./components/AdminShell";
import { TenantLayout } from "./components/TenantLayout";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { Login } from "./routes/Login";
import { Signup } from "./routes/Signup";
import { Dashboard } from "./routes/Dashboard";
import { Triage } from "./routes/Triage";
import { Sources } from "./routes/Sources";
import { MasterTables } from "./routes/MasterTables";
import { Settings } from "./routes/Settings";
import { Showcase } from "./routes/Showcase";
import { AdminTenants } from "./routes/admin/Tenants";

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
              <EngineerModeProvider>
                <BootGate>
                  {(boot) => (
                    <OpenTabsProvider>
                      <CreateTableModalProvider>
                        <Routes>
                          {/* /app and / redirect via BootGate effect — these are sync fallbacks */}
                          <Route path="/" element={<Navigate to="/app" replace />} />
                          <Route
                            path="/app"
                            element={
                              <Navigate
                                to={`/app/${boot.memberships[0]?.slug ?? "admin"}`}
                                replace
                              />
                            }
                          />

                          {/* Super-admin shell */}
                          {boot.isSuperAdmin ? (
                            <Route path="/app/admin" element={<AdminShell />}>
                              <Route index element={<AdminTenants />} />
                              <Route path="tenants" element={<AdminTenants />} />
                            </Route>
                          ) : null}

                          {/* Per-tenant shell — TenantLayout validates slug, drives session lifecycle */}
                          <Route
                            path="/app/:tenantSlug/*"
                            element={
                              <TenantLayout
                                memberships={boot.memberships}
                                isSuperAdmin={boot.isSuperAdmin}
                              />
                            }
                          >
                            <Route element={<AppShell memberships={boot.memberships} />}>
                              <Route index element={<Dashboard />} />
                              <Route path="triage" element={<Triage />} />
                              <Route path="sources" element={<Sources />} />
                              <Route path="tables" element={<MasterTables />} />
                              <Route path="settings" element={<Settings />} />
                            </Route>
                          </Route>

                          <Route path="*" element={<Navigate to="/app" replace />} />
                        </Routes>
                      </CreateTableModalProvider>
                    </OpenTabsProvider>
                  )}
                </BootGate>
              </EngineerModeProvider>
            </RouteErrorBoundary>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
