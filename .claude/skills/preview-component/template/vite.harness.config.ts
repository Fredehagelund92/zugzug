import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Isolated component preview — mounts a real component through the app's real
// Vite + Tailwind + tokens pipeline, redirecting only the modules that need a
// live backend to harness mocks. Run: bunx vite --config vite.harness.config.ts
//
// The resolveId plugin is keyed on the importer being a component file, so it
// only rewrites imports made *by* the previewed component, never its children.
// Add a `source === "..."` line (and a matching harness mock file) for each
// extra backend/context module your target component imports.
export default defineConfig({
  root: resolve(__dirname, "harness"),
  plugins: [
    {
      name: "harness-mock-backend",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !importer.includes("/src/components/")) return null;
        if (source === "../store") return resolve(__dirname, "harness/store-mock.ts");
        if (source === "../lib/use-tenant-navigate")
          return resolve(__dirname, "harness/nav-mock.ts");
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  server: { port: 5199, host: true },
});
