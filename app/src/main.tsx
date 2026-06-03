import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./globals.css";
import { setAccent, setTheme, toggleTheme } from "./theme";
import { EngineerModeProvider } from "./lib/engineer-mode";
import { UndoStackProvider } from "./components/datagrid";
import { BootGate } from "./components/BootGate";
import { AppShell } from "./components/AppShell";
import { Login } from "./routes/Login";
import { Dashboard } from "./routes/Dashboard";
import { Mapping } from "./routes/Mapping";
import { Sources } from "./routes/Sources";
import { MasterTables } from "./routes/MasterTables";
import { Settings } from "./routes/Settings";
import { Showcase } from "./routes/Showcase";

declare global {
  interface Window {
    BrandApp: { setAccent: typeof setAccent; setTheme: typeof setTheme; toggleTheme: typeof toggleTheme };
  }
}
window.BrandApp = { setAccent, setTheme, toggleTheme };

const root = document.getElementById("root")!;

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Public — no session required */}
        <Route path="/login" element={<Login />} />
        <Route path="/design" element={<Showcase />} />

        {/* Protected — BootGate checks /api/auth/me and redirects to /login on 401 */}
        <Route
          path="*"
          element={
            <UndoStackProvider>
              <EngineerModeProvider>
                <BootGate>
                  <Routes>
                    <Route path="/" element={<Navigate to="/app" replace />} />
                    <Route element={<AppShell />}>
                      <Route path="/app" element={<Dashboard />} />
                      <Route path="/app/mapping" element={<Mapping />} />
                      <Route path="/app/sources" element={<Sources />} />
                      <Route path="/app/tables" element={<MasterTables />} />
                      <Route path="/app/settings" element={<Settings />} />
                    </Route>
                    <Route path="*" element={<Navigate to="/app" replace />} />
                  </Routes>
                </BootGate>
              </EngineerModeProvider>
            </UndoStackProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
