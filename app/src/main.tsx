import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./globals.css";
import { setAccent, setTheme, toggleTheme } from "./theme";
import { initStore } from "./store";
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

// Preload backend state so the first render has dimensions/drafts/audit/users,
// then mount. (An async boot fn rather than top-level await, which Vite's build
// target rejects.)
const root = document.getElementById("root")!;

async function boot() {
  try {
    await initStore();
  } catch (e) {
    root.innerHTML = `<pre style="font:14px ui-monospace,monospace;padding:2rem;color:var(--danger)">Can't reach the Zug Zug API.\nStart it with:  cd server && bun run start\n\n${String(e)}</pre>`;
    return;
  }
  createRoot(root).render(
    <React.StrictMode>
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
    </React.StrictMode>,
  );
}

void boot();
