---
name: preview-component
description: Screenshot a single React component from the zugzug `app/` in isolation — mounts it through the app's real Vite + Tailwind v4 + tokens pipeline and captures it with headless Chrome, without standing up Postgres or the Bun backend. Use when you need to SEE or verify a component's UI (a modal, popover, card, empty state) after changing it, and driving the full stack (login → navigate → open) is overkill.
---

# Preview a component in isolation

The full app needs Postgres + the Bun backend (`:8787`) + login before you can
reach most UI. When you only changed one component and want to *see* it, that's
too much. This harness mounts the real component through the app's real build
pipeline and screenshots it — no backend, no login.

**It renders the actual component** (real Tailwind classes, real `tokens.css`,
real child components). It only fakes the data hooks the component calls. What
you see is what ships, minus live data.

## When to use

- You changed a modal / popover / card / empty state and want to eyeball it.
- You want a screenshot to verify a design change or share the result.
- Driving the live app to the component (auth + routing + state) isn't worth it.

**Not** for behaviour that depends on the backend (real scans, saves, websocket
presence) — for that, run the full stack per `README.md` (`docker compose up`).

## Recipe

All paths are under `app/`. Work from there: `cd app`.

### 1. Drop in the harness

Copy the template files from this skill into `app/`:

```bash
SKILL=.claude/skills/preview-component/template
cp "$SKILL/vite.harness.config.ts" app/vite.harness.config.ts
cp -r "$SKILL/harness" app/harness
```

You now have `app/harness/{index.html,main.tsx,harness.css,store-mock.ts,nav-mock.ts}`
and `app/vite.harness.config.ts`.

### 2. Point it at your component

Edit `app/harness/main.tsx` — import your component and render it with whatever
props open it. The template renders `CreateTableModal` open; swap the import and
JSX. Use a `?query=` param to pick variants (the template reads `?mode=`).

### 3. Mock only what the component needs

The component's data hooks must resolve without a backend. Two are pre-mocked:
`../store` (→ `harness/store-mock.ts`) and `../lib/use-tenant-navigate`
(→ `harness/nav-mock.ts`), wired by a `resolveId` plugin in the harness config.

- If your component reads **other** store exports, add them to `store-mock.ts`.
- If it calls **another** backend/context hook, add a mock file and a line to
  the `resolveId` plugin in `vite.harness.config.ts`.
- The `resolveId` match is keyed on `importer.includes("/src/components/")`, so
  it only redirects imports *from component files* — child components keep the
  real modules. Widen the key if your target lives elsewhere (e.g. `/src/routes/`).

### 4. Run + screenshot

```bash
cd app
bunx vite --config vite.harness.config.ts > /tmp/harness.log 2>&1 &
sleep 4   # wait for "ready in" in /tmp/harness.log

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=680,900 \
  --virtual-time-budget=4500 \
  --screenshot=/tmp/preview.png "http://localhost:5199/?mode=external_id"
```

Then **Read `/tmp/preview.png`** — look at it. A blank/unstyled frame means a
failure (see Gotchas). Adjust `--window-size` to fit the component; bump
`--virtual-time-budget` if React hasn't mounted yet.

### 5. Clean up

```bash
pkill -f vite.harness.config
rm -rf app/harness app/vite.harness.config.ts
```

Leave the tree with only your real change. (Or keep the harness committed if the
team wants a standing preview tool — but default to removing it.)

## Gotchas (the parts that cost time)

- **Unstyled screenshot = Tailwind didn't scan your component.** Tailwind v4
  auto-detects sources from the *Vite root*, which is `harness/` here — so it
  misses `src/`. `harness/harness.css` fixes it: it `@import "../src/globals.css"`
  (the real Tailwind + tokens entry) then `@source "../src"` to point the scanner
  at the components. `main.tsx` must import `./harness.css`, **not** `globals.css`.
- **Hook crashes on mount** (e.g. `useNavLinks` needs router context, `useSources`
  needs the websocket store) → mock the module via the `resolveId` plugin. Don't
  wrap the harness in real providers; faking the module is simpler and keeps the
  render deterministic.
- **No `chromium-cli` / Playwright** in this environment — use the installed
  Google Chrome binary directly with `--headless=new --screenshot`. Because it
  can't click, render the component already-open and use query params for states
  a click would otherwise reach (the ComboSelect dropdowns won't open in a static
  shot — that's expected; screenshot the closed/placeholder state).
- **Port 5199** is the harness default (avoids clashing with the real dev server
  on 5173). Change it in `vite.harness.config.ts` if taken.
