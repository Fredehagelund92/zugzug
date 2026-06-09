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
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { Login } from "./routes/Login";
import { Signup } from "./routes/Signup";
import { Dashboard } from "./routes/Dashboard";
import { Triage } from "./routes/Triage";
import { Sources } from "./routes/Sources";
import { MasterTables } from "./routes/MasterTables";
import { Settings } from "./routes/Settings";
import { Showcase } from "./routes/Showcase";

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
                  <OpenTabsProvider>
                    <CreateTableModalProvider>
                      <Routes>
                        <Route path="/" element={<Navigate to="/app" replace />} />
                        <Route element={<AppShell />}>
                          <Route path="/app" element={<Dashboard />} />
                          <Route path="/app/triage" element={<Triage />} />
                          <Route path="/app/sources" element={<Sources />} />
                          <Route path="/app/tables" element={<MasterTables />} />
                          <Route path="/app/settings" element={<Settings />} />
                        </Route>
                        <Route path="*" element={<Navigate to="/app" replace />} />
                      </Routes>
                    </CreateTableModalProvider>
                  </OpenTabsProvider>
                </BootGate>
              </EngineerModeProvider>
            </RouteErrorBoundary>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
