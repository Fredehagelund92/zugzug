import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/api/t/:slug/dimensions", () =>
    HttpResponse.json([
      { id: "d1", dimension: "Vendors", dimTable: "dim_vendors", mapTable: "map_vendors", rows: 0 },
    ]),
  ),
  http.get("/api/t/:slug/drafts", () => HttpResponse.json([])),
  http.get("/api/t/:slug/preferences", () => HttpResponse.json({})),
  http.get("/api/t/:slug/audit", () => HttpResponse.json([])),
  http.get("/api/users", () =>
    HttpResponse.json({ currentUser: { id: "u1", name: "Me" }, collaborators: [] }),
  ),
  http.get("/api/auth/me", () => HttpResponse.json({ id: "u1", name: "Me" })),
  http.get("/api/warehouse/health", () => HttpResponse.json({ ok: true })),
];
