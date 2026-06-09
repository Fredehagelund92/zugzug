/* server.ts — the thin HTTP API over the repo (ARCHITECTURE.md's backend seam).
   Bun.serve; one shared DuckDB connection underneath (serialised). The frontend
   (app/) talks to this; Vite proxies /api → :PORT in dev. */

import { env } from "./env.ts";
import * as repo from "./repo.ts";
import type { NumberFormat } from "./repo-shared.ts";
import {
  getSessionUser,
  handleGoogleRedirect,
  handleGoogleCallback,
  handleMe,
  handleLogout,
  handleAuthConfig,
  handleDevLogin,
} from "./auth.ts";
import * as team from "./team.ts";
import * as tables from "./tables.ts";
import { pgAll, pgEnd } from "./pg.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
import { getAdapter } from "./warehouse/registry.ts";

const corsHeaders = {
  "access-control-allow-origin": env.origin,
  "access-control-allow-credentials": "true",
  vary: "Origin",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });

const noContent = () => new Response(null, { status: 204, headers: corsHeaders });
const err = (e: unknown, status = 500) =>
  json({ error: e instanceof Error ? e.message : String(e) }, status);

registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});

const adapter = await getAdapter();
const ok = await adapter.ping();
if (!ok) {
  console.error("✗ warehouse adapter ping failed");
  process.exit(1);
}
console.log(
  `· connected (${adapter.capabilities.id}${adapter.capabilities.writable ? ", writable" : ", read-only"})`,
);

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
setInterval(() => {
  void scheduleTick();
}, 60_000);
console.log("· scheduler started (1m tick)");

async function handle(req: Request, setUid: (uid: string) => void): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const seg = pathname.split("/").filter(Boolean); // ["api","dimensions",":id",...]
  const method = req.method;

  if (method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });

  if (pathname === "/health" || pathname === "/api/health") {
    try {
      await pgAll(`SELECT 1`);
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
  }

  if (seg[0] !== "api") return new Response("Zug Zug API. Try /api/dimensions", { status: 404 });

  // Auth routes — no session required
  if (seg[1] === "auth") {
    if (seg[2] === "google" && method === "GET") return handleGoogleRedirect(req);
    if (seg[2] === "callback" && method === "GET") return handleGoogleCallback(req);
    if (seg[2] === "me" && method === "GET") return handleMe(req);
    if (seg[2] === "logout" && method === "POST") return handleLogout(req);
    if (seg[2] === "config" && method === "GET") return handleAuthConfig();
    if (seg[2] === "dev" && method === "GET") {
      if (!env.devBypassAuth) return json({ error: "not found" }, 404);
      return handleDevLogin();
    }
    return json({ error: "not found" }, 404);
  }

  // Session gate — all other /api/* routes require a valid session
  let sessionUser;
  try {
    sessionUser = await getSessionUser(req);
  } catch (e) {
    return err(e, 503);
  }
  if (!sessionUser) return json({ error: "Unauthorized" }, 401);
  const me = sessionUser.id;
  setUid(me);

  try {
    // GET /api/preferences ; PUT /api/preferences {publishThreshold, suggestThreshold, scanSchedule}
    if (seg[1] === "preferences" && seg.length === 2) {
      if (method === "GET") return json(await repo.getPreferences());
      if (method === "PUT") {
        const p = (await req.json()) as {
          publishThreshold: number;
          suggestThreshold: number;
          scanSchedule: "15m" | "hourly" | "daily" | null;
        };
        await repo.setPreferences(p);
        return noContent();
      }
    }

    if (seg[1] === "triage" && seg[2] === "ai-hint" && seg.length === 3 && method === "GET") {
      const dimId = url.searchParams.get("dimId") ?? "";
      const raw = url.searchParams.get("raw") ?? "";
      if (!dimId || !raw) return err("dimId and raw required", 400);
      const dim = await repo.getDimension(dimId);
      if (!dim) return json({ error: "not found" }, 404);
      if (!env.anthropicApiKey) return json({ error: "ai_not_configured" }, 503);
      try {
        const canonicalLabels = dim.canonical.map((c) => c.label);
        const hint = await repo.getAiHint(dimId, raw, canonicalLabels, { label: dim.dimension });
        return json(hint);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("timeout") || msg.includes("AbortError")) {
          return json({ error: "hint_timeout" }, 503);
        }
        return json({ error: "hint_error" }, 502);
      }
    }

    // GET /api/users → { currentUser, collaborators }
    if (seg[1] === "users" && seg.length === 2 && method === "GET") {
      const users = await repo.listUsers();
      return json({
        currentUser: users.find((u) => u.id === me) ?? users[0],
        collaborators: users,
      });
    }

    // GET /api/workspace/info — adapter capability metadata for the frontend badge
    if (seg[1] === "workspace" && seg[2] === "info" && seg.length === 3 && method === "GET") {
      const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
      const adapterInstance = await getAdapterFn();
      return json({
        adapter: adapterInstance.capabilities.id,
        writable: adapterInstance.capabilities.writable,
        canonicalMode: adapterInstance.capabilities.writable ? "warehouse" : "postgres-export",
        warehouseDb: env.warehouseDb || null,
      });
    }

    // /api/sources — registered source columns (cached); /facets; /scan
    if (seg[1] === "sources") {
      if (seg.length === 2 && method === "GET")
        return json(
          await repo.listSources({
            q: url.searchParams.get("q") ?? undefined,
            schema: url.searchParams.get("schema") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
          }),
        );
      if (seg[2] === "facets" && seg.length === 3 && method === "GET")
        return json(await repo.sourceFacets());
      if (seg[2] === "scan-status" && seg.length === 3 && method === "GET")
        return json(await repo.scanStatus());
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
      return json(
        await repo.searchCatalog({
          q: url.searchParams.get("q") ?? undefined,
          schema: url.searchParams.get("schema") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 50),
          offset: Number(url.searchParams.get("offset") ?? 0),
        }),
      );

    // GET /api/audit ; POST /api/audit {action, detail}
    if (seg[1] === "audit" && seg.length === 2) {
      if (method === "GET")
        return json(await repo.listAudit(Number(url.searchParams.get("limit") ?? 30)));
      if (method === "POST") {
        const { action, detail } = (await req.json()) as { action: string; detail: string };
        await repo.appendAuditAs(me, action, detail);
        return noContent();
      }
    }

    // GET / PATCH /api/grid-layout/:dimId — per-user-per-dim layout (widths/order/hidden)
    if (seg[1] === "grid-layout" && seg.length === 3) {
      const dimId = decodeURIComponent(seg[2]!);
      if (method === "GET") return json(await repo.getGridLayout(me, dimId));
      if (method === "PATCH") {
        const body = (await req.json()) as repo.GridLayoutConfig;
        await repo.setGridLayout(me, dimId, body);
        return noContent();
      }
    }

    if (seg[1] === "tables") {
      if (seg.length === 2 && method === "POST") {
        try {
          const input = (await req.json()) as tables.CreateTableInput;
          const result = await tables.createTable(input, me);
          return json(result, 201);
        } catch (e) {
          if (e instanceof AppError) {
            return json({ error: e.message, code: e.code }, e.status);
          }
          throw e;
        }
      }
      return json({ error: "not found" }, 404);
    }

    if (seg[1] === "dimensions") {
      // GET /api/dimensions[?full=true] ; POST /api/dimensions {name}
      // ?full=true returns the full MappingDimension shapes (canonical rows,
      // values, fields, …) in one response — kills the N+1 the client used to
      // make at boot (1 list + N detail fetches).
      if (seg.length === 2) {
        if (method === "GET") {
          if (url.searchParams.get("full") === "true") {
            const metas = await repo.listDimensions();
            const fulls = await Promise.all(metas.map((m) => repo.getDimension(m.id)));
            return json(fulls.filter((d): d is NonNullable<typeof d> => d != null));
          }
          return json(await repo.listDimensions());
        }
        if (method === "POST") {
          const { name, keyKind } = (await req.json()) as {
            name: string;
            keyKind?: "slug" | "external_id";
          };
          return json({ id: await repo.addDimension(name, [], { keyKind }, me) }, 201);
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
          const b = (await req.json()) as {
            raw: string;
            status: "mapped" | "skipped";
            targetLabel: string | null;
            targetKey: string | null;
          };
          await repo.saveDraft(id, b.raw, b.status, b.targetLabel ?? null, b.targetKey ?? null, me);
          return noContent();
        }
        if (seg.length === 5 && method === "DELETE") {
          await repo.discardDraft(id, decodeURIComponent(seg[4]!), me);
          return noContent();
        }
      }
      // POST /api/dimensions/:id/sources {table, column} — wire a warehouse column
      if (seg[3] === "sources" && seg.length === 4 && method === "POST") {
        const { table, column } = (await req.json()) as { table: string; column: string };
        await repo.addSource(id, table, column);
        return noContent();
      }
      // POST /api/dimensions/:id/derive {table, column, nameColumn?} — seed canonical
      if (seg[3] === "derive" && seg.length === 4 && method === "POST") {
        const { table, column, nameColumn } = (await req.json()) as {
          table: string;
          column: string;
          nameColumn?: string;
        };
        return json(await repo.deriveCanonical(id, table, column, nameColumn, {}, me));
      }
      // POST /api/dimensions/:id/fields {label, type?, options?, numberFormat?, ratingMax?, referencedDimId?, displayFields?} — add an attribute column
      if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
        const { label, type, options, numberFormat, ratingMax, referencedDimId, displayFields } =
          (await req.json()) as {
            label: string;
            type?: string;
            options?: { label: string; color: string | null }[];
            numberFormat?: NumberFormat;
            ratingMax?: number;
            referencedDimId?: string;
            displayFields?: string[];
          };
        return json(
          await repo.addField(
            id,
            label,
            type,
            options as repo.OptionDef[] | undefined,
            { numberFormat, ratingMax, referencedDimId, displayFields },
            me,
          ),
        );
      }
      // POST /api/dimensions/:id/fields/:field/options {label} — append a select option
      if (seg[3] === "fields" && seg[5] === "options" && seg.length === 6 && method === "POST") {
        const field = decodeURIComponent(seg[4]!);
        const { label, color } = (await req.json()) as { label: string; color?: string | null };
        const res = await repo.addColumnOption(
          id,
          field,
          label,
          (color ?? null) as repo.PaletteName | null,
          {},
          me,
        );
        return res ? json(res) : json({ error: "not a select column" }, 400);
      }
      // PUT/PATCH/DELETE /api/dimensions/:id/fields/:field — rename / change type / update meta / delete
      if (seg[3] === "fields" && seg.length === 5) {
        const field = decodeURIComponent(seg[4]!);
        if (method === "PUT") {
          const body = (await req.json()) as {
            label?: string;
            type?: string;
            options?: { label: string; color: string | null }[];
            numberFormat?: NumberFormat;
            ratingMax?: number;
            coerceInvalidToNull?: boolean;
          };
          if (body.label != null) {
            await repo.renameColumn(id, field, body.label, me);
          }
          if (body.type != null) {
            const res = await repo.changeColumnType(id, field, {
              newType: body.type,
              options: body.options as repo.OptionDef[] | undefined,
              numberFormat: body.numberFormat,
              ratingMax: body.ratingMax,
              coerceInvalidToNull: body.coerceInvalidToNull ?? false,
              userId: me,
            });
            return json(res);
          }
          return noContent();
        }
        if (method === "PATCH") {
          const body = (await req.json()) as {
            description?: string | null;
            field_config?: string | null;
          };
          await repo.updateField(
            id,
            field,
            { description: body.description, fieldConfig: body.field_config },
            me,
          );
          return noContent();
        }
        if (method === "DELETE") return json(await repo.deleteColumn(id, field, me));
      }
      // canonical record management
      if (seg[3] === "canonical") {
        if (seg.length === 4 && method === "POST") {
          const { label, key } = (await req.json()) as { label: string; key?: string };
          await repo.addCanonicalOne(id, label, key, me);
          return noContent();
        }
        if (seg[4] === "merge" && seg.length === 5 && method === "POST") {
          if (url.searchParams.get("confirm") !== "true") {
            throw new AppError("CONFIRMATION_REQUIRED", "merge requires ?confirm=true", 400);
          }
          const { survivor, losers } = (await req.json()) as { survivor: string; losers: string[] };
          return json({ merged: await repo.mergeCanonical(id, survivor, losers, me) });
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
          if (method === "PUT") {
            const { label } = (await req.json()) as { label: string };
            await repo.renameCanonical(id, ck, label, me);
            return noContent();
          }
          if (method === "DELETE") return json(await repo.retireCanonical(id, ck, me));
        }
      }
      // POST /api/dimensions/:id/commit
      if (seg[3] === "commit" && seg.length === 4 && method === "POST")
        return json(await repo.commit(id, me));
      // GET /api/dimensions/:id/snapshot.parquet — Parquet export of the dim's map table
      if (seg[3] === "snapshot.parquet" && seg.length === 4 && method === "GET") {
        const dimId = seg[2]!;
        const dim = await repo.getDimension(dimId);
        if (!dim) return json({ error: "not found" }, 404);
        const { exportCanonicalToParquet } = await import("./warehouse/parquet-exporter.ts");
        const buf = await exportCanonicalToParquet({
          dimId: dim.id,
          dimTable: dim.dimTable,
          mapTable: dim.mapTable,
          keyCol: dim.keyCol,
        });
        return new Response(buf, {
          status: 200,
          headers: {
            ...corsHeaders,
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${dimId}-map.parquet"`,
            "cache-control": "no-store",
          },
        });
      }
    }

    // GET /api/team/members ; POST /api/team/members ; DELETE /api/team/members/:email
    if (seg[1] === "team" && seg[2] === "members") {
      if (seg.length === 3 && method === "GET") return json(await team.listMembers());
      if (seg.length === 3 && method === "POST") {
        const { email } = (await req.json()) as { email: string };
        try {
          await team.addMember(email, me);
          return noContent();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "wrong_domain")
            return json({ error: `Only @${env.allowedDomain} emails allowed` }, 400);
          if (msg.includes("unique") || msg.includes("duplicate"))
            return json({ error: "already_exists" }, 409);
          throw e;
        }
      }
      if (seg.length === 4 && method === "DELETE") {
        const email = decodeURIComponent(seg[3]!);
        try {
          await team.removeMember(email, me);
          return noContent();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "cannot_remove_self") return json({ error: "cannot_remove_self" }, 400);
          throw e;
        }
      }
    }

    return json({ error: `no route for ${method} ${pathname}` }, 404);
  } catch (e) {
    if (e instanceof AppError) {
      return json({ error: e.message, code: e.code }, e.status);
    }
    console.error(`✗ ${method} ${pathname}:`, e);
    return err(e);
  }
}

const server = Bun.serve({
  port: env.port,
  idleTimeout: 120,
  maxRequestBodySize: 512 * 1024, // 512 KB — largest legit payload is a grid layout
  async fetch(req) {
    const reqId = crypto.randomUUID();
    const start = performance.now();
    let userId: string | undefined;
    let status = 500;
    try {
      const res = await handle(req, (uid) => {
        userId = uid;
      });
      status = res.status;
      const headers = new Headers(res.headers);
      headers.set("x-request-id", reqId);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      console.error(`✗ ${req.method} ${new URL(req.url).pathname}:`, e);
      status = 500;
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500,
        headers: { "content-type": "application/json", "x-request-id": reqId, ...corsHeaders },
      });
    } finally {
      log({
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        msg: "request",
        reqId,
        method: req.method,
        path: new URL(req.url).pathname,
        status,
        ms: Math.round(performance.now() - start),
        userId,
      });
    }
  },
});

console.log(`\nZug Zug API listening on http://localhost:${server.port}\n`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`· ${signal} received — draining…`);
  server.stop(false); // stop accepting new connections (Bun has no await-drain API)
  await new Promise<void>((resolve) => setTimeout(resolve, 250)); // best-effort 250ms drain window
  await Promise.race([
    pgEnd(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("pgEnd timeout")), 5000)),
  ]).catch((e) => console.error("pgEnd failed:", e));
  console.log("· shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
