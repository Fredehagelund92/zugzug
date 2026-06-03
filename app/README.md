# Zug Zug — app

The Zug Zug frontend: a master-data layer over a DuckDB warehouse. Built **from**
the brand guide — the look is imported, never re-interpreted.

> **Now wired to a real backend** (`../server/`): `src/store.ts` fetches `/api`
> (Vite proxies it to the Bun server on :8787; canonical/drafts/audit in Postgres,
> warehouse scan in MotherDuck). Start the API first — `cd ../server && bun run start`
> — see `../server/.env.example` and `ARCHITECTURE.md`. The store still exposes the
> same hooks, so components are unchanged.

## Stack
- **Bun** (package manager) · **Vite 6** (bundler/dev) · **React 18 + TypeScript**
- **Tailwind v4** — its theme is aliased to the brand tokens via `@theme inline`
  in `src/globals.css`, so every utility (`bg-accent`, `text-ink`, `font-display`,
  `rounded-md`, …) resolves to a live `var(--token)`.

## The trust chain (why it can't drift)
1. `src/tokens.css` is the brand's single source of truth, exported **verbatim**
   from `../brand/zugzug-brand-guide.html`. Never hand-edit it.
2. `src/globals.css` imports it and maps each token into Tailwind's theme.
3. Components use token-backed utilities only — **no hex literals**, no `dark:`
   variants (light/dark flows through `tokens.css`'s `[data-theme]` block).
4. The gate proves it:
   ```
   python3 ../../brand/../?  # from repo root:
   python3 ~/.claude/skills/brand-guide/check_app.py \
     --tokens brand --src app/src --source brand/zugzug-brand-guide.html
   ```
   → round-trip, zero-leak, wrapper-purity, token-ref all PASS.

To re-brand the whole app: re-run the brand guide (new accent/fonts), re-export
`tokens.css`, copy it to `src/` — zero component changes.

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
  globals.css        tailwind + tokens.css import + @theme alias + base
  tokens.css         brand source of truth (verbatim; do not edit)
  theme.ts           useTheme(): light/dark toggle + setAccent (fidelity proof)
  data.ts            typed mock fixtures (master/source tables, mappings)
  lib/cx.ts          className joiner
  components/        Button, Mark (ZZ logomark) — Tailwind, token-backed
  routes/Showcase    the design-system surface (tokens, type, buttons, live theming)
reference/           app-kit.css + component gallery — the pixel spec to match
```

`reference/` is the verified component kit + gallery from the brand guide. It is
the fidelity target when converting more components to Tailwind, not linked into
the app.
