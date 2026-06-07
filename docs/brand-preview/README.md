***REMOVED*** Brand preview (historical reference)

> Not consumed by the app. The live source of truth is **[`app/src/tokens.css`](../../app/src/tokens.css)** and **[`app/src/app-kit.css`](../../app/src/app-kit.css)**.

These are the original brand-guide artifacts: the printable brand book, the component kit, and the first export of design tokens. The app has since evolved past them — additional surface colors, workflow-specific `committed`/`staged` semantics, per-table tints, more granular shadow/duration scales. Treat the files here as **visual specimen and PDF leave-behind**, not as authoritative tokens.

***REMOVED******REMOVED*** What's here

- `zugzug-brand-guide.html` — printable brand book (idea, logo, color, type, components, motion, voice). Open in a browser; print to PDF for stakeholders.
- `zugzug-components.html` — themed component kit using these tokens. A visual reference, not the build target.
- `index.html` — landing card linking to the above.
- `tokens.css` / `tokens.json` / `tokens.ts` — the **original** token export. Use only to render these HTML files correctly.
- `app-kit.css` — the original app-kit utility layer, referenced by the component kit.

***REMOVED******REMOVED*** Why kept

Cheap to keep. The brand book is still useful for explaining the design intent to non-engineers, and the HTML is self-contained (no build step). If the gap between this and `app/src/` grows wide enough to confuse, regenerate or delete.

***REMOVED******REMOVED*** Live source of truth

| What | Where |
|---|---|
| Design narrative & how to use the brand | `../../DESIGN.md` (repo root) |
| Token definitions consumed at runtime | `app/src/tokens.css` |
| Utility layer | `app/src/app-kit.css` |
| Per-table tint palette | `app/src/lib/palette.ts` |
| Theme module | `app/src/theme.ts` |
