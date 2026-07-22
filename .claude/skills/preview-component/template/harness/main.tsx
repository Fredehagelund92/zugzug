import { createRoot } from "react-dom/client";
import "./harness.css"; // NOT ../src/globals.css — see harness.css
import { setTheme } from "../src/theme";

// ── Edit below to preview a different component ───────────────────────────────
// Import your component and render it "open" with whatever props reveal it.
// Read a ?query= param to switch between states a click would otherwise reach.
import { CreateTableModal } from "../src/components/CreateTableModal";
import type { CreateTableMode } from "../src/store";

setTheme("dark"); // or "light" to check the paper theme

const params = new URLSearchParams(location.search);
const mode = (params.get("mode") as CreateTableMode | null) ?? "external_id";

createRoot(document.getElementById("root")!).render(
  <CreateTableModal open defaultMode={mode} onClose={() => {}} onCreated={() => {}} />,
);
// ─────────────────────────────────────────────────────────────────────────────
