import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/api/t/:slug/users", () =>
    HttpResponse.json({
      currentUser: { id: "u1", name: "Me", initials: "M" },
      collaborators: [],
    }),
  ),
  http.get("/api/auth/me", () =>
    HttpResponse.json({ id: "u1", name: "Me", email: "me@example.com", initials: "M" }),
  ),
  http.get("/api/t/:slug/tables", () =>
    HttpResponse.json([
      {
        id: "d1",
        refTable: "Vendors",
        dimTable: "dim_vendors",
        mapTable: "map_vendors",
        keyCol: "vendor_key",
        rows: 0,
        record: [],
        counts: {
          newCount: 0,
          mappedCount: 0,
          totalDistinct: 0,
          unmappedRowsTotal: 0,
          mappedRowsTotal: 0,
          scannedAt: null,
        },
      },
    ]),
  ),
  http.get("/api/t/:slug/sources", () => HttpResponse.json([])),
  http.get("/api/t/:slug/audit", () => HttpResponse.json([])),
  http.get("/api/t/:slug/preferences", () => HttpResponse.json({})),
  http.get("/api/t/:slug/health/connections", () =>
    HttpResponse.json({
      warehouse: { status: "disabled", lastCheckedAt: new Date().toISOString() },
      postgres: { status: "ok", lastCheckedAt: new Date().toISOString() },
    }),
  ),
  http.get("/api/t/:slug/drafts", () => HttpResponse.json([])),
  http.get("/api/warehouse/health", () => HttpResponse.json({ ok: true })),
];
