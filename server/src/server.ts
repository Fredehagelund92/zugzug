/* server.ts — the thin HTTP API over the repo (ARCHITECTURE.md's backend seam).
   Bun.serve; one shared DuckDB connection underneath (serialised). The frontend
   (app/) talks to this; Vite proxies /api → :PORT in dev. */

import { connect } from "./db.ts";
import { env } from "./env.ts";
import * as repo from "./repo.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const noContent = () => new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
const err = (e: unknown, status = 500) => json({ error: e instanceof Error ? e.message : String(e) }, status);

/** the acting user — demo presence via a header, default Ada. */
const actor = (req: Request) => req.headers.get("x-user-id")?.trim() || "u_ada";

await connect();
console.log("· connected (MotherDuck + Postgres attached)");

/* scheduler — every minute, if any wired source is due (per its 15m/hourly/
   daily cadence), run a full scanSources. scanSources handles all wired
   sources, so a coarse trigger is fine at this scale. Single in-flight guard
   prevents overlap if a scan takes longer than the tick. */
let scanInFlight = false;
async function scheduleTick(): Promise<void> {
  if (scanInFlight) return;
  try {
    if (!(await repo.anyScanDue(new Date()))) return;
    scanInFlight = true;
    const n = await repo.scanSources();
    console.log(`· scheduler: scanned ${n} source${n === 1 ? "" : "s"}`);
  } catch (e) {
    console.error("· scheduler tick failed:", e);
  } finally {
    scanInFlight = false;
  }
}
setInterval(() => { void scheduleTick(); }, 60_000);
console.log("· scheduler started (1m tick)");

const server = Bun.serve({
  port: env.port,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const seg = pathname.split("/").filter(Boolean); // ["api","dimensions",":id",...]
    const method = req.method;

    if (method === "OPTIONS")
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-user-id" } });

    if (seg[0] !== "api") return new Response("Zug Zug API. Try /api/dimensions", { status: 404 });

    try {
      // GET /api/preferences ; PUT /api/preferences {publishThreshold, suggestThreshold}
      if (seg[1] === "preferences" && seg.length === 2) {
        if (method === "GET") return json(await repo.getPreferences());
        if (method === "PUT") {
          const p = (await req.json()) as { publishThreshold: number; suggestThreshold: number };
          await repo.setPreferences(p);
          return noContent();
        }
      }

      // GET /api/users → { currentUser, collaborators }
      if (seg[1] === "users" && seg.length === 2 && method === "GET") {
        const users = await repo.listUsers();
        const me = actor(req);
        return json({ currentUser: users.find((u) => u.id === me) ?? users[0], collaborators: users });
      }

      // /api/sources — registered source columns (cached); /facets; /scan
      if (seg[1] === "sources") {
        if (seg.length === 2 && method === "GET")
          return json(await repo.listSources({
            q: url.searchParams.get("q") ?? undefined,
            schema: url.searchParams.get("schema") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
          }));
        if (seg[2] === "facets" && seg.length === 3 && method === "GET")
          return json(await repo.sourceFacets());
        if (seg[2] === "scan" && seg.length === 3 && method === "POST")
          return json({ scanned: await repo.scanSources() });
        // GET /api/sources/unmapped?dimId=&table=&column=&limit=
        if (seg[2] === "unmapped" && seg.length === 3 && method === "GET") {
          const dimId = url.searchParams.get("dimId") ?? "";
          const table = url.searchParams.get("table") ?? "";
          const column = url.searchParams.get("column") ?? "";
          const limit = Number(url.searchParams.get("limit") ?? 5);
          if (!dimId || !table || !column) return err("dimId, table, column required", 400);
          return json(await repo.topUnmapped(dimId, table, column, limit));
        }
      }

      // GET /api/catalog — browse/search the warehouse catalog (the 1000+ tables)
      if (seg[1] === "catalog" && seg.length === 2 && method === "GET")
        return json(await repo.searchCatalog({
          q: url.searchParams.get("q") ?? undefined,
          schema: url.searchParams.get("schema") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 50),
          offset: Number(url.searchParams.get("offset") ?? 0),
        }));

      // GET /api/audit ; POST /api/audit {action, detail}
      if (seg[1] === "audit" && seg.length === 2) {
        if (method === "GET") return json(await repo.listAudit(Number(url.searchParams.get("limit") ?? 30)));
        if (method === "POST") {
          const { action, detail } = (await req.json()) as { action: string; detail: string };
          await repo.appendAuditAs(actor(req), action, detail);
          return noContent();
        }
      }

      if (seg[1] === "dimensions") {
        // GET /api/dimensions ; POST /api/dimensions {name}
        if (seg.length === 2) {
          if (method === "GET") return json(await repo.listDimensions());
          if (method === "POST") {
            const { name, keyKind } = (await req.json()) as { name: string; keyKind?: "slug" | "external_id" };
            return json({ id: await repo.addDimension(name, [], { keyKind }) }, 201);
          }
        }
        const id = seg[2] ? decodeURIComponent(seg[2]) : "";
        // GET /api/dimensions/:id
        if (seg.length === 3 && id && method === "GET") {
          const dim = await repo.getDimension(id);
          return dim ? json(dim) : json({ error: "not found" }, 404);
        }
        if (seg[3] === "drafts") {
          // GET /api/dimensions/:id/drafts ; PUT (upsert) ; DELETE /.../:raw
          if (seg.length === 4 && method === "GET") return json(await repo.listDrafts(id));
          if (seg.length === 4 && method === "PUT") {
            const b = (await req.json()) as { raw: string; status: "mapped" | "skipped"; targetLabel: string | null; targetKey: string | null };
            await repo.saveDraft(id, b.raw, b.status, b.targetLabel ?? null, b.targetKey ?? null, actor(req));
            return noContent();
          }
          if (seg.length === 5 && method === "DELETE") {
            await repo.discardDraft(id, decodeURIComponent(seg[4]!), actor(req));
            return noContent();
          }
        }
        // POST /api/dimensions/:id/sources {table, column} — wire a warehouse column
        if (seg[3] === "sources" && seg.length === 4 && method === "POST") {
          const { table, column } = (await req.json()) as { table: string; column: string };
          await repo.addSource(id, table, column);
          return noContent();
        }
        // PUT /api/dimensions/:id/sources/schedule {table, column, schedule}
        if (seg[3] === "sources" && seg[4] === "schedule" && seg.length === 5 && method === "PUT") {
          const { table, column, schedule } = (await req.json()) as { table: string; column: string; schedule: string | null };
          await repo.setSourceSchedule(id, table, column, schedule);
          return noContent();
        }
        // POST /api/dimensions/:id/derive {table, column, nameColumn?} — seed canonical
        if (seg[3] === "derive" && seg.length === 4 && method === "POST") {
          const { table, column, nameColumn } = (await req.json()) as { table: string; column: string; nameColumn?: string };
          return json(await repo.deriveCanonical(id, table, column, nameColumn));
        }
        // POST /api/dimensions/:id/fields {label, type?} — add an attribute column
        if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
          const { label, type } = (await req.json()) as { label: string; type?: string };
          return json(await repo.addField(id, label, type));
        }
        // canonical record management
        if (seg[3] === "canonical") {
          if (seg.length === 4 && method === "POST") {
            const { label, key } = (await req.json()) as { label: string; key?: string };
            await repo.addCanonicalOne(id, label, key);
            return noContent();
          }
          if (seg[4] === "merge" && seg.length === 5 && method === "POST") {
            const { survivor, losers } = (await req.json()) as { survivor: string; losers: string[] };
            return json({ merged: await repo.mergeCanonical(id, survivor, losers) });
          }
          const ck = seg[4] ? decodeURIComponent(seg[4]) : "";
          if (seg[5] === "variants" && seg.length === 6 && method === "GET")
            return json(await repo.listVariants(id, ck));
          // PUT /api/dimensions/:id/canonical/:key/field/:field {value}
          if (seg[5] === "field" && seg.length === 7 && method === "PUT") {
            const { value } = (await req.json()) as { value: string | null };
            await repo.setFieldValue(id, ck, decodeURIComponent(seg[6]!), value ?? null);
            return noContent();
          }
          if (seg.length === 5 && ck) {
            if (method === "PUT") { const { label } = (await req.json()) as { label: string }; await repo.renameCanonical(id, ck, label); return noContent(); }
            if (method === "DELETE") return json(await repo.retireCanonical(id, ck));
          }
        }
        // POST /api/dimensions/:id/commit
        if (seg[3] === "commit" && seg.length === 4 && method === "POST")
          return json(await repo.commit(id, actor(req)));
      }

      return json({ error: `no route for ${method} ${pathname}` }, 404);
    } catch (e) {
      console.error(`✗ ${method} ${pathname}:`, e);
      return err(e);
    }
  },
});

console.log(`\nZug Zug API listening on http://localhost:${server.port}\n`);
