import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./globals.css";
import { setAccent, setTheme, toggleTheme } from "./theme";
import { EngineerModeProvider } from "./lib/engineer-mode";
import { UndoStackProvider } from "./components/datagrid";
import { BootGate } from "./components/BootGate";
import { AppShell } from "./components/AppShell";
import { Dashboard } from "./routes/Dashboard";
import { Mapping } from "./routes/Mapping";
import { Sources } from "./routes/Sources";
import { MasterTables } from "./routes/MasterTables";
import { Settings } from "./routes/Settings";
import { Showcase } from "./routes/Showcase";

/* Fidelity proof, dev-only: the accent is fixed to the brand in the UI, but you
   can still re-theme the whole app live from the console — call
   BrandApp.setAccent(hex) with any colour and every token-backed utility moves. */
declare global {
  interface Window {
    BrandApp: { setAccent: typeof setAccent; setTheme: typeof setTheme; toggleTheme: typeof toggleTheme };
  }
}
window.BrandApp = { setAccent, setTheme, toggleTheme };

// Mount React immediately; BootGate runs initStore() and shows a styled
// skeleton (or styled API-error with Retry) while it resolves, instead of
// the previous blank page → raw-HTML-on-failure dance.
const root = document.getElementById("root")!;

createRoot(root).render(
  <React.StrictMode>
    <UndoStackProvider>
      <EngineerModeProvider>
        <BootGate>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Navigate to="/app" replace />} />
              <Route element={<AppShell />}>
                <Route path="/app" element={<Dashboard />} />
                <Route path="/app/mapping" element={<Mapping />} />
                <Route path="/app/sources" element={<Sources />} />
                <Route path="/app/tables" element={<MasterTables />} />
                <Route path="/app/settings" element={<Settings />} />
              </Route>
              <Route path="/design" element={<Showcase />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Routes>
          </BrowserRouter>
        </BootGate>
      </EngineerModeProvider>
    </UndoStackProvider>
  </React.StrictMode>,
);
