# Zug Zug — website & docs

The marketing landing page and documentation for Zug Zug, built with
[Fumadocs](https://fumadocs.dev) (Next.js 16, React 19, Tailwind v4). It's a
fully **static export** — deployable to any static host.

## Develop

```bash
cd docs-site
npm install
npm run dev      # http://localhost:3000
```

- **Landing** (`/`) is rendered from `app/landing-content.ts`.
- **Docs** live in `content/docs/**.mdx`; section order is set by `meta.json`
  files. Add a page by dropping in an `.mdx` file with `title` + `description`
  frontmatter.

## Build

```bash
npm run build    # -> out/  (static site)
```

Serve `out/` with any static file server to preview the production artifact.

## Deploy

### Vercel (recommended for the site)

Import the repo and set **Root Directory → `docs-site`**. Everything else is
default (Next.js auto-detected; `output: 'export'` serves the static build; no
env vars). Search works out of the box — the export prerenders `out/api/search`.

### Any static host

`npm run build` and publish `out/` to Netlify, Cloudflare Pages, GitHub Pages,
S3/CloudFront, etc. For GitHub Pages (served under `/<repo>`), add a `basePath`
in `next.config.mjs`.

## Note on the landing page

`app/landing-content.ts` is the committed source of truth for the landing markup
and its scoped CSS. It's generated from a local design mockup
(`docs/website-preview/index.html`, gitignored); regenerate after editing the
mockup, or edit `landing-content.ts` directly.

## Not the product demo

This is the website only. A live demo of the Zug Zug **app** (a stateful
Bun + Postgres + DuckDB stack) does not run on Vercel — use a container host
(Fly.io / Railway / Render / a VM) with the repo's `compose.prod.yml`.
