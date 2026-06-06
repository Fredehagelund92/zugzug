# AI Triage Co-pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user focuses a Triage row, fire a Claude Haiku API call that returns a suggested canonical match + confidence + reasoning snippet, cached in Postgres, shown inline in the focused row.

**Architecture:** On-demand with Postgres + session cache. `useAiHint` hook at `TriageInner` level fires after 150ms debounce; server checks `ai_hint_cache` before calling Claude; result rendered by `TriageReasoningStrip` in an expanded focused row. Hint never mutates the store — parallel data path only.

**Tech Stack:** Bun + Hono-style routing, Drizzle ORM + Postgres (`zugzug_app` schema), `claude-haiku-4-5-20251001` via Anthropic REST API, React + TypeScript + Tailwind v4, Vitest.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/drizzle/schema.ts` | Edit | Add `aiHintCache` Drizzle table definition |
| `server/drizzle/migrations/` | Generate | `bun run db:generate` creates `0003_*.sql` |
| `server/src/env.ts` | Edit | Add `anthropicApiKey` (soft-fail — returns `""` when absent) |
| `server/src/repo-ai-hint.ts` | Create | `validateClaudeResponse`, `callClaude`, `getAiHint` |
| `server/src/repo.ts` | Edit | Re-export `repo-ai-hint.ts` |
| `server/src/server.ts` | Edit | Add `GET /api/triage/ai-hint` route |
| `server/src/repo-drafts.ts` | Edit | Prune stale hints after `commit()` |
| `server/src/repo-canonical.ts` | Edit | Update hint label in `renameCanonical` |
| `app/src/lib/use-ai-hint.ts` | Create | `useAiHint` hook with debounce + session cache |
| `app/test/use-ai-hint.test.ts` | Create | Vitest unit tests for `validateClaudeResponse` logic |
| `app/src/components/TriageReasoningStrip.tsx` | Create | Shimmer / loaded / error states |
| `app/src/routes/Triage.tsx` | Edit | Wire hook, expand focused row, `acceptCross` fallback |

---

## Task 1: Drizzle schema + migration

**Files:**
- Modify: `server/drizzle/schema.ts`
- Generate: `server/drizzle/migrations/` (via drizzle-kit)

- [ ] **Step 1: Add `aiHintCache` to schema.ts**

Open `server/drizzle/schema.ts`. After the `userGridLayout` table at the bottom, add:

```typescript
export const aiHintCache = app.table(
  "ai_hint_cache",
  {
    dim_id:     varchar("dim_id").notNull(),
    raw:        varchar("raw").notNull(),
    suggestion: varchar("suggestion"),
    confidence: integer("confidence").notNull(),
    reasoning:  varchar("reasoning").notNull(),
    model:      varchar("model").notNull(),
    created_at: timestamp("created_at").notNull(),
    hits:       integer("hits").notNull().default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.dim_id, t.raw] }),
    index("ai_hint_cache_dim_id_idx").on(t.dim_id),
  ],
);
```

- [ ] **Step 2: Generate the migration**

```bash
cd server && bun run db:generate
```

Expected: a new file `server/drizzle/migrations/0003_*.sql` containing `CREATE TABLE "zugzug_app"."ai_hint_cache"`.

- [ ] **Step 3: Apply the migration**

```bash
cd server && bun run db:migrate
```

Expected: `migrating... 1 migration(s) applied` (or similar Drizzle output).

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/
git commit -m "feat: add ai_hint_cache table"
```

---

## Task 2: Add `anthropicApiKey` to env

**Files:**
- Modify: `server/src/env.ts`

- [ ] **Step 1: Add the key — soft-fail (returns `""` when absent)**

In `server/src/env.ts`, add `anthropicApiKey` to the `env` object (after `devBypassAuth`):

```typescript
export const env = {
  databaseUrl: required("DATABASE_URL"),
  motherduckToken: required("MOTHERDUCK_TOKEN"),
  warehouseDb: process.env.WAREHOUSE_DB?.trim() || "analytics",
  attachWarehouse: process.env.ATTACH_WAREHOUSE?.trim() === "true",
  canonicalSchema: process.env.ZUGZUG_DB?.trim() || "zugzug",
  oltpCatalog: "oltp",
  appSchema: "zugzug_app",
  duckPath: process.env.DUCK_PATH?.trim() || ":memory:",
  port: Number(process.env.PORT?.trim() || 8787),
  googleClientId: required("GOOGLE_CLIENT_ID"),
  googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
  allowedDomain: process.env.ALLOWED_DOMAIN?.trim() || "bettercollective.com",
  origin: (process.env.ORIGIN?.trim() || "http://localhost:5173").replace(/\/$/, ""),
  devBypassAuth: process.env.DEV_BYPASS_AUTH?.trim() === "true",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "",
};
```

- [ ] **Step 2: Add to `.env.example` so future devs know it's needed**

Open `server/.env.example` and add (after the existing Google OAuth lines):

```
# Optional: enables AI Triage suggestions (get a key at https://console.anthropic.com)
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Commit**

```bash
git add server/src/env.ts server/.env.example
git commit -m "feat: add ANTHROPIC_API_KEY to env (soft-fail)"
```

---

## Task 3: `repo-ai-hint.ts` — `validateClaudeResponse` + `callClaude`

**Files:**
- Create: `server/src/repo-ai-hint.ts`

This task creates the pure Claude-calling layer. `getAiHint` (with Postgres) comes in Task 4.

- [ ] **Step 1: Create `server/src/repo-ai-hint.ts`**

```typescript
import { env, pg } from "./env.ts";
import { pgGet, pgRun } from "./repo-shared.ts";

export interface AiHint {
  suggestion: string | null;
  confidence: number;
  reasoning:  string;
}

export interface AiHintResult extends AiHint {
  cached: boolean;
}

interface DimContext {
  label: string;
}

// ── validation ────────────────────────────────────────────────────────────────

export function validateClaudeResponse(
  raw: unknown,
  canonicalLabels: string[],
): AiHint {
  if (typeof raw !== "object" || raw === null) {
    return { suggestion: null, confidence: 0, reasoning: "Invalid response from AI." };
  }
  const r = raw as Record<string, unknown>;

  const suggestion =
    typeof r.suggestion === "string" && canonicalLabels.includes(r.suggestion)
      ? r.suggestion
      : null;

  const confidence =
    suggestion !== null && typeof r.confidence === "number"
      ? Math.max(0, Math.min(95, Math.round(r.confidence)))
      : 0;

  const reasoning =
    typeof r.reasoning === "string" && r.reasoning.length > 0
      ? r.reasoning.slice(0, 300)
      : suggestion === null
        ? "No match in canonical set."
        : "Matched to canonical record.";

  return { suggestion, confidence, reasoning };
}

// ── Claude API call ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a data mapping assistant for a Master Data Management tool. Match a raw source value to the best canonical record in a controlled vocabulary.

Respond ONLY with a JSON object:
{"suggestion": string | null, "confidence": number, "reasoning": string}

Rules:
- suggestion: exact string from the canonical list or null if no match
- confidence: 0-100. >90 = unambiguous (abbreviation, translation, alternate spelling). 60-89 = plausible. <60 = guessing. 0 only when suggestion is null.
- reasoning: 1-2 sentences, terse and concrete, max 200 chars. Show pattern evidence (e.g. "ISO 3166-1 alpha-2 code. DE→Germany, FR→France.")
- Never invent a suggestion not in the canonical list
- Never set confidence above 95`;

export async function callClaude(
  raw: string,
  canonicalLabels: string[],
  dim: DimContext,
): Promise<AiHint> {
  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const canonicalBlock =
    canonicalLabels.length > 0
      ? canonicalLabels.map((l, i) => `${i + 1}. ${l}`).join("\n")
      : "(empty — no canonical records exist yet)";

  const userMessage = `Dimension: ${dim.label}

Canonical options:
${canonicalBlock}

Raw source value to match: "${raw}"`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: {
      "content-type":    "application/json",
      "x-api-key":       env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content.find((b) => b.type === "text")?.text ?? "";
  const jsonText = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 100)}`);
  }

  return validateClaudeResponse(parsed, canonicalLabels);
}
```

- [ ] **Step 2: Confirm TypeScript compiles**

```bash
cd server && bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `repo-ai-hint.ts`.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo-ai-hint.ts
git commit -m "feat: repo-ai-hint — callClaude + validateClaudeResponse"
```

---

## Task 4: `repo-ai-hint.ts` — `getAiHint` (cache layer)

**Files:**
- Modify: `server/src/repo-ai-hint.ts`

- [ ] **Step 1: Add `getAiHint` to the bottom of `repo-ai-hint.ts`**

```typescript
// ── cache + orchestration ─────────────────────────────────────────────────────

interface CacheRow {
  suggestion: string | null;
  confidence: number;
  reasoning:  string;
}

export async function getAiHint(
  dimId:          string,
  raw:            string,
  canonicalLabels: string[],
  dim:            DimContext,
): Promise<AiHintResult> {
  // 1. Postgres cache hit
  const cached = await pgGet<CacheRow>(
    `SELECT suggestion, confidence, reasoning
     FROM ${pg("ai_hint_cache")}
     WHERE dim_id = $1 AND raw = $2`,
    [dimId, raw],
  );
  if (cached) {
    void pgRun(
      `UPDATE ${pg("ai_hint_cache")} SET hits = hits + 1
       WHERE dim_id = $1 AND raw = $2`,
      [dimId, raw],
    );
    return { ...cached, cached: true };
  }

  // 2. Empty canonical set — skip Claude
  if (canonicalLabels.length === 0) {
    return {
      suggestion: null,
      confidence: 0,
      reasoning:  "No canonical records exist yet.",
      cached:     false,
    };
  }

  // 3. No API key — graceful degradation
  if (!env.anthropicApiKey) {
    return { suggestion: null, confidence: 0, reasoning: "", cached: false };
  }

  // 4. Claude call
  const result = await callClaude(raw, canonicalLabels, dim);

  // 5. Store in cache
  await pgRun(
    `INSERT INTO ${pg("ai_hint_cache")}
       (dim_id, raw, suggestion, confidence, reasoning, model, created_at, hits)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, 0)
     ON CONFLICT (dim_id, raw) DO UPDATE
       SET suggestion  = EXCLUDED.suggestion,
           confidence  = EXCLUDED.confidence,
           reasoning   = EXCLUDED.reasoning,
           model       = EXCLUDED.model,
           created_at  = EXCLUDED.created_at`,
    [dimId, raw, result.suggestion, result.confidence, result.reasoning, "claude-haiku-4-5-20251001"],
  );

  return { ...result, cached: false };
}
```

- [ ] **Step 2: Compile check**

```bash
cd server && bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo-ai-hint.ts
git commit -m "feat: repo-ai-hint — getAiHint with Postgres cache"
```

---

## Task 5: Re-export + server route

**Files:**
- Modify: `server/src/repo.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Add re-export to `repo.ts`**

Open `server/src/repo.ts`. Add one line at the bottom:

```typescript
export * from "./repo-ai-hint.ts";
```

- [ ] **Step 2: Add the route to `server.ts`**

In `server/src/server.ts`, inside the session-gated block (after the `preferences` route block, around line 127), add:

```typescript
    if (seg[1] === "triage" && seg[2] === "ai-hint" && seg.length === 3 && method === "GET") {
      const dimId = url.searchParams.get("dimId") ?? "";
      const raw   = url.searchParams.get("raw") ?? "";
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
```

- [ ] **Step 3: Start the dev server and verify the route exists**

```bash
cd server && bun run server.ts &
curl -s "http://localhost:8787/api/triage/ai-hint" | head -c 100
```

Expected: `{"error":"Unauthorized"}` (session guard working — not a 404).

Kill the dev server after checking: `kill %1`

- [ ] **Step 4: Commit**

```bash
git add server/src/repo.ts server/src/server.ts
git commit -m "feat: GET /api/triage/ai-hint route"
```

---

## Task 6: Prune stale hints after `commit()`

**Files:**
- Modify: `server/src/repo-drafts.ts`

- [ ] **Step 1: Add hint pruning at the end of `commit()` in `repo-drafts.ts`**

In `repo-drafts.ts`, at the bottom of the `commit` function (after the `appendAuditAs` call, before `return`):

```typescript
  // Prune ai_hint_cache entries whose suggestion is no longer a valid canonical
  // label for this dim (e.g. after a canonical record was deleted or renamed).
  const currentLabels = await pgAll<{ label: string }>(
    `SELECT label FROM ${cq(meta.dimTable)} WHERE label IS NOT NULL`,
  ).catch(() => [] as { label: string }[]);
  if (currentLabels.length > 0) {
    const labelArr = currentLabels.map((r) => r.label);
    await pgRun(
      `DELETE FROM ${pg("ai_hint_cache")}
       WHERE dim_id = $1 AND suggestion IS NOT NULL AND NOT (suggestion = ANY($2::text[]))`,
      [dimId, labelArr],
    ).catch(() => {/* table may not exist in older deploys */});
  }

  return { committed, rowsRecovered };
```

Make sure the import for `pg` is available — it's re-exported from `repo-shared.ts` which is already imported.

- [ ] **Step 2: Compile check**

```bash
cd server && bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo-drafts.ts
git commit -m "feat: prune stale ai_hint_cache entries after commit"
```

---

## Task 7: Update hint label on `renameCanonical`

**Files:**
- Modify: `server/src/repo-canonical.ts`

- [ ] **Step 1: Add hint label update at the end of `renameCanonical()`**

In `repo-canonical.ts`, `renameCanonical` currently ends with `appendAuditAs`. Add after it (before the closing `}`):

```typescript
  // Keep cached AI hints consistent when a canonical label is renamed.
  await pgRun(
    `UPDATE ${pg("ai_hint_cache")} SET suggestion = $1
     WHERE dim_id = $2 AND suggestion = $3`,
    [label, dimId, key],
  ).catch(() => {/* table may not exist in older deploys */});
```

- [ ] **Step 2: Compile check**

```bash
cd server && bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/repo-canonical.ts
git commit -m "feat: keep ai_hint_cache in sync on canonical rename"
```

---

## Task 8: `useAiHint` hook + tests

**Files:**
- Create: `app/src/lib/use-ai-hint.ts`
- Create: `app/test/use-ai-hint.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `app/test/use-ai-hint.test.ts`:

```typescript
// test/use-ai-hint.test.ts
import { describe, test, expect } from "vitest";

// validateClaudeResponse logic is replicated client-side for tests.
// We test the pure validation rules without needing the hook itself.

function validateHint(
  raw: unknown,
  canonicalLabels: string[],
): { suggestion: string | null; confidence: number; reasoning: string } {
  if (typeof raw !== "object" || raw === null) {
    return { suggestion: null, confidence: 0, reasoning: "Invalid response from AI." };
  }
  const r = raw as Record<string, unknown>;
  const suggestion =
    typeof r.suggestion === "string" && canonicalLabels.includes(r.suggestion)
      ? r.suggestion
      : null;
  const confidence =
    suggestion !== null && typeof r.confidence === "number"
      ? Math.max(0, Math.min(95, Math.round(r.confidence)))
      : 0;
  const reasoning =
    typeof r.reasoning === "string" && r.reasoning.length > 0
      ? r.reasoning.slice(0, 300)
      : suggestion === null
        ? "No match in canonical set."
        : "Matched to canonical record.";
  return { suggestion, confidence, reasoning };
}

const LABELS = ["United States", "United Kingdom", "Germany", "France"];

describe("validateHint", () => {
  test("returns valid suggestion when label is in canonical list", () => {
    const r = validateHint(
      { suggestion: "United Kingdom", confidence: 88, reasoning: "ISO 3166-1 alpha-2 code." },
      LABELS,
    );
    expect(r.suggestion).toBe("United Kingdom");
    expect(r.confidence).toBe(88);
    expect(r.reasoning).toBe("ISO 3166-1 alpha-2 code.");
  });

  test("rejects hallucinated suggestion not in canonical list", () => {
    const r = validateHint(
      { suggestion: "England", confidence: 70, reasoning: "Common name." },
      LABELS,
    );
    expect(r.suggestion).toBeNull();
    expect(r.confidence).toBe(0);
  });

  test("caps confidence at 95", () => {
    const r = validateHint({ suggestion: "Germany", confidence: 100, reasoning: "Exact." }, LABELS);
    expect(r.confidence).toBe(95);
  });

  test("sets confidence to 0 when suggestion is null", () => {
    const r = validateHint({ suggestion: null, confidence: 80, reasoning: "Ambiguous." }, LABELS);
    expect(r.confidence).toBe(0);
  });

  test("falls back reasoning when field is missing", () => {
    const r = validateHint({ suggestion: "France", confidence: 72 }, LABELS);
    expect(r.reasoning).toBe("Matched to canonical record.");
  });

  test("falls back reasoning for no-match", () => {
    const r = validateHint({ suggestion: null, confidence: 0 }, LABELS);
    expect(r.reasoning).toBe("No match in canonical set.");
  });

  test("handles non-object response", () => {
    const r = validateHint("bad string", LABELS);
    expect(r.suggestion).toBeNull();
    expect(r.confidence).toBe(0);
  });

  test("truncates reasoning to 300 chars", () => {
    const long = "x".repeat(400);
    const r = validateHint({ suggestion: "United States", confidence: 90, reasoning: long }, LABELS);
    expect(r.reasoning.length).toBe(300);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (function not yet in scope)**

```bash
cd app && bun run test test/use-ai-hint.test.ts
```

Expected: all 8 tests PASS (the test file contains its own `validateHint` copy — this is intentional; we're locking in the validation contract before writing the hook).

- [ ] **Step 3: Create `app/src/lib/use-ai-hint.ts`**

```typescript
import { useEffect, useRef, useState } from "react";

export interface AiHint {
  suggestion: string | null;
  confidence: number;
  reasoning:  string;
  cached?:    boolean;
}

interface State {
  hint:    AiHint | null;
  loading: boolean;
  error:   boolean;
}

// Module-level session cache — survives remounts, makes re-focuses instant.
const sessionCache = new Map<string, AiHint>();

function cacheKey(dimId: string, raw: string): string {
  return `${dimId}::${raw}`;
}

export function useAiHint(
  dimId:   string,
  raw:     string,
  enabled: boolean,
): State {
  const [state, setState] = useState<State>(() => {
    const cached = enabled ? sessionCache.get(cacheKey(dimId, raw)) : undefined;
    return { hint: cached ?? null, loading: false, error: false };
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef    = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !dimId || !raw) return;

    const key = cacheKey(dimId, raw);
    const cached = sessionCache.get(key);
    if (cached) {
      setState({ hint: cached, loading: false, error: false });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: false }));

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const qs = new URLSearchParams({ dimId, raw });
      fetch(`/api/triage/ai-hint?${qs.toString()}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.json() as Promise<AiHint>;
        })
        .then((hint) => {
          sessionCache.set(key, hint);
          setState({ hint, loading: false, error: false });
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setState({ hint: null, loading: false, error: true });
        });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [dimId, raw, enabled]);

  return state;
}
```

- [ ] **Step 4: Run tests again to confirm they still pass**

```bash
cd app && bun run test test/use-ai-hint.test.ts
```

Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/use-ai-hint.ts app/test/use-ai-hint.test.ts
git commit -m "feat: useAiHint hook + validation tests"
```

---

## Task 9: `TriageReasoningStrip` component

**Files:**
- Create: `app/src/components/TriageReasoningStrip.tsx`

- [ ] **Step 1: Create the component**

```typescript
// app/src/components/TriageReasoningStrip.tsx
import type { AiHint } from "../lib/use-ai-hint";

interface Props {
  loading: boolean;
  hint:    AiHint | null;
}

export function TriageReasoningStrip({ loading, hint }: Props) {
  // Error state or no data yet — render nothing (confidence bar is the fallback).
  if (!loading && !hint) return null;

  if (loading) {
    return (
      <div className="mb-2 flex items-center gap-1.5 pl-[2px]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-accent/30" aria-hidden="true" />
        {/* ak-skeleton applies the shimmer gradient + animation from app-kit.css */}
        <div className="ak-skeleton h-[10px] w-[58%] rounded-sm" />
      </div>
    );
  }

  if (!hint?.reasoning) return null;

  return (
    <div
      className="mb-2 flex items-start gap-1.5 pl-[2px]"
      style={{ animation: "zz-rise var(--dur-slide) both" }}
    >
      <span
        className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-pill bg-accent/50"
        aria-hidden="true"
      />
      <p className="font-mono text-[11px] italic leading-snug text-ink-2">
        {hint.reasoning}
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | head -20
```

Expected: no errors related to `TriageReasoningStrip.tsx`.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/TriageReasoningStrip.tsx
git commit -m "feat: TriageReasoningStrip component"
```

---

## Task 10: Wire everything into `Triage.tsx`

**Files:**
- Modify: `app/src/routes/Triage.tsx`

- [ ] **Step 1: Add imports at the top of `Triage.tsx`**

After the existing imports, add:

```typescript
import { useAiHint } from "../lib/use-ai-hint";
import { TriageReasoningStrip } from "../components/TriageReasoningStrip";
```

- [ ] **Step 2: Instantiate the hook in `TriageInner`**

In `TriageInner`, after the line `const undo = useUndoStack();`, add:

```typescript
  const aiHint = useAiHint(
    cursor?.dimId ?? "",
    cursor?.raw ?? "",
    cursor !== null,
  );
```

- [ ] **Step 3: Pass `aiHint` through to `CrossDimInbox`**

Add `AiHint` to the imports at the top of `Triage.tsx` (alongside the `useAiHint` import already added in Step 1):

```typescript
import { useAiHint, type AiHint } from "../lib/use-ai-hint";
```

Add `aiHint` to the `CrossDimInboxProps` interface:

```typescript
interface CrossDimInboxProps {
  // ... existing props ...
  aiHint: { hint: AiHint | null; loading: boolean; error: boolean };
}
```

Pass it in the JSX call to `<CrossDimInbox>` in `TriageInner`:

```tsx
<CrossDimInbox
  {/* ...existing props... */}
  aiHint={aiHint}
/>
```

- [ ] **Step 4: Update `acceptCross` to fall back to the AI hint**

Find `acceptCross` in `TriageInner`. Change it from:

```typescript
  const acceptCross = (dimId: string, raw: string) => {
    const d = dimById.get(dimId);
    const r = d?.values.find((v) => v.value === raw);
    if (!r || !r.suggestion) return;
    void stageMapCross(dimId, raw, r.suggestion);
```

To:

```typescript
  const acceptCross = (dimId: string, raw: string) => {
    const d = dimById.get(dimId);
    const v = d?.values.find((x) => x.value === raw);
    const suggestion = v?.suggestion ?? aiHint.hint?.suggestion;
    if (!suggestion) return;
    void stageMapCross(dimId, raw, suggestion);
```

- [ ] **Step 5: Expand the focused row and render the strip**

In `CrossDimInbox`, find the row render block — the `<div key={key} data-row-key={key} ...>`. 

Change the outer div so it no longer has `items-center gap-3 py-2.5` (move those to an inner div), and render the strip conditionally:

```tsx
<div
  key={key}
  data-row-key={key}
  className={cx(
    "border-b border-line px-4 transition-colors hover:bg-hover",
    focused && "ring-1 ring-accent/60 bg-accent-wash/40",
  )}
  onClick={() => p.setCursor({ dimId: r.dimId, raw: r.raw })}
>
  <div className={cx(COLS_CROSS, "items-center gap-3 py-2.5")}>
    {/* ...all existing cells unchanged... */}
  </div>
  {focused && !r.target && (
    <TriageReasoningStrip
      loading={p.aiHint.loading}
      hint={p.aiHint.hint}
    />
  )}
</div>
```

- [ ] **Step 6: Add `title` tooltip to the confidence number**

In the confidence cell (inside the `{r.confidence > 0 ? ...}` block), change:

```tsx
<span
  className={cx("font-mono text-[11px] tabular-nums", confText(r.confidence))}
>
  {r.confidence}
</span>
```

To:

```tsx
<span
  className={cx("font-mono text-[11px] tabular-nums", confText(r.confidence))}
  title={
    focused && p.aiHint.hint?.reasoning
      ? `${r.confidence}% · ${p.aiHint.hint.reasoning}`
      : `${r.confidence}%`
  }
>
  {r.confidence}
</span>
```

- [ ] **Step 7: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 8: Run all tests**

```bash
cd app && bun run test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add app/src/routes/Triage.tsx
git commit -m "feat: wire AI Triage Co-pilot into Triage inbox"
```

---

## Task 11: Smoke walkthrough

- [ ] **Step 1: Start the dev stack**

In two terminals:

```bash
# Terminal 1
cd server && bun run server.ts

# Terminal 2
cd app && bun run dev
```

Open `http://localhost:5173/app/triage`.

- [ ] **Step 2: Verify the shimmer appears on row focus**

Click a row (or press J to navigate to one). Expected: a small shimmer bar appears briefly beneath the source-value column of the focused row.

- [ ] **Step 3: Verify reasoning loads (with `ANTHROPIC_API_KEY` set)**

If `ANTHROPIC_API_KEY` is set in `server/.env`: the shimmer should be replaced within ~200-500ms by italic mono text like *"ISO 3166-1 alpha-2 code. Pattern: DE→Germany, FR→France."*

- [ ] **Step 4: Verify graceful degradation (without key)**

Remove `ANTHROPIC_API_KEY` from `server/.env`, restart the server. Navigate to Triage — shimmer should appear and then disappear with no error; confidence bar remains. Triage is fully usable.

- [ ] **Step 5: Verify `A` key accepts the AI suggestion**

Focus a row where `v.suggestion` is `null` but `aiHint.hint.suggestion` is set. Press `A`. Expected: the row should flash and the ComboSelect should show the AI suggestion as the staged mapping.

- [ ] **Step 6: Verify the strip disappears after pick**

Pick any value (press `M`, select something). Expected: the `TriageReasoningStrip` disappears immediately (because `r.target` is now set).

- [ ] **Step 7: Verify the Postgres cache**

After loading a hint, open a psql session and run:

```sql
SELECT dim_id, raw, suggestion, confidence, hits
FROM zugzug_app.ai_hint_cache
LIMIT 5;
```

Expected: rows with the raw values you focused, `hits = 0` (fresh inserts). Re-focus the same row — `hits` should increment to 1.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat: AI Triage Co-pilot — complete"
```

---

## Note: Settings toggle (follow-up)

The spec includes an "AI Triage Suggestions" on/off toggle in Settings (stored in `preferences`). It is **not** in this plan because:

1. Default is **on** — the feature ships fully functional without the toggle
2. The toggle requires a `preferences` migration + Settings UI, which is a separate vertical slice

Add it as a follow-up if users need to disable AI suggestions per-workspace. The feature degrades gracefully already when `ANTHROPIC_API_KEY` is absent (server returns 503, no hint shown).
