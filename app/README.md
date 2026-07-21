# Zugzug — app

The Zugzug frontend: a React SPA over the Bun API in `../server/`. See
[ARCHITECTURE.md](../ARCHITECTURE.md) for how the frontend fits the whole system
and [DESIGN.md](../DESIGN.md) for the design-token system.

`src/store.ts` calls the backend over `/api` (Vite proxies it to the Bun server
on `:8787` in dev); records, drafts, and audit live in Postgres, warehouse scans
go through the server's adapter. Start the API first:
`cd ../server && bun run start`.

## Stack
- **Bun** (package manager) · **Vite** (bundler/dev) · **React 18 + TypeScript** · **React Router**
- **Tailwind v4** — its theme aliases the design tokens via `@theme inline` in
  `src/globals.css`, so every utility (`bg-accent`, `text-ink`, `rounded-md`, …)
  resolves to a live `var(--token)`. Tokens are defined in `src/tokens.css`; never
  hardcode hex in components.
- **Yjs** for live presence/cursors · **Sentry** for error tracking.

## Run
```
bun install
bun run dev        # http://localhost:5173
bun run build      # production bundle → dist/
bun run typecheck
```

## Layout
```
src/
  main.tsx           React entry + router + Sentry
  store.ts           app state + API-backed data (records, drafts, audit)
  api.ts             fetch wrapper (apiFetch)
  globals.css        Tailwind + tokens import + @theme alias
  tokens.css         design tokens (source of truth; do not hardcode hex)
  theme.ts           light/dark toggle
  components/        UI library — datagrid, admin, auth, settings, integrations
  routes/            page-level React Router views
  lib/, hooks/       API clients, business logic, hooks
```
