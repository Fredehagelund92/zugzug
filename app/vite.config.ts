import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite + React + Tailwind v4. Tailwind reads src/globals.css, where the brand
// tokens (tokens.css) are imported and aliased into the Tailwind theme.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    // This repo lives on a Windows mount (/mnt/c) where inotify doesn't fire,
    // so file edits never reach Vite's watcher. Polling makes HMR work in WSL.
    watch: { usePolling: true, interval: 120 },
    // The Bun backend (server/) serves /api on :8787. Proxy avoids CORS in dev.
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
