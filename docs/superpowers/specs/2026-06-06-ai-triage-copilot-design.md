# AI Triage Co-pilot — Design Spec

**Date:** 2026-06-06
**Status:** Ready for implementation

---

## Problem

The Triage inbox asks users to map raw warehouse values to canonical dimension records. The `suggestion` and `confidence` fields already exist in the data model but are always `null`/`0` — the system has no intelligence about which mapping is right. Users see a bare raw value and must either know the answer or guess.

For non-technical analysts, this is a wall. For technical engineers doing bulk review, it is slow. Neither group gets an explanation of *why* a match is or isn't obvious.

---

## Solution

When a user focuses a row in Triage, fire a Claude API call (`claude-haiku-4-5-20251001`) that returns a suggested canonical match, a confidence score, and a brief reasoning snippet. The result is cached in Postgres and shown inline in the focused row, beneath the source value.

This is a **judgment amplifier** — it speeds up decisions and builds trust without removing human control. Every suggestion is still staged, reviewed, and committed by a human.

---

## Architecture

### Data flow

```
User focuses row (cursor change)
  → useAiHint hook (150ms debounce)
    → module-level session cache hit? → render immediately
    → GET /api/triage/ai-hint?dimId=X&raw=Y
      → Postgres ai_hint_cache hit? → return cached
      → callClaude(raw, canonicalLabels, dimContext)
        → claude-haiku-4-5-20251001, 256 max_tokens
        → validateClaudeResponse (hard canonical list guard)
      → INSERT INTO ai_hint_cache
      → return { suggestion, confidence, reasoning, cached }
    → render TriageReasoningStrip in focused row
```

### Three-store impact

- **Warehouse (MotherDuck):** no change — AI reads only from Postgres canonical labels
- **Master store (MotherDuck):** no change
- **App state (Postgres):** one new table (`ai_hint_cache`)

---

## Cache Table

```sql
CREATE TABLE zugzug_app.ai_hint_cache (
  dim_id      TEXT        NOT NULL,
  raw         TEXT        NOT NULL,
  suggestion  TEXT,
  confidence  INTEGER     NOT NULL,
  reasoning   TEXT        NOT NULL,
  model       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  hits        INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (dim_id, raw)
);
CREATE INDEX ai_hint_cache_dim_id_idx ON zugzug_app.ai_hint_cache (dim_id);
```

**Cache key:** `(dim_id, raw)` — suggestion is an output, not part of identity.

**Invalidation:**
- Post-`commit()`: delete hints for the dim where `suggestion` is no longer a valid canonical label
- On canonical record rename: `UPDATE ai_hint_cache SET suggestion = <new_label> WHERE dim_id = X AND suggestion = <old_label>`
- No TTL — hints are deterministic given a stable canonical set

**`hits` column:** incremented on each cache hit; provides visibility into high-traffic values and future cache-warming candidates.

---

## Server: `repo-ai-hint.ts`

New file at `server/src/repo-ai-hint.ts`.

### `getAiHint(dimId, raw, canonicalLabels, dimContext)`

1. Check `ai_hint_cache` for `(dim_id, raw)` — return immediately + increment `hits` if found
2. Call `callClaude(raw, canonicalLabels, dimContext)`
3. Upsert result into `ai_hint_cache`
4. Return result

### `callClaude(raw, canonicalLabels, dimContext)`

**Model:** `claude-haiku-4-5-20251001`
**max_tokens:** 256
**Timeout:** 8 seconds via `AbortSignal.timeout(8000)`

**System prompt:**
```
You are a data mapping assistant for a Master Data Management tool. Your job is to match a raw source value to the best canonical record in a controlled vocabulary.

Respond ONLY with a JSON object:
{"suggestion": string | null, "confidence": number, "reasoning": string}

Rules:
- suggestion: exact string from the canonical list or null
- confidence: 0-100. >90 = unambiguous. 60-89 = plausible. <60 = guessing. 0 only when suggestion is null.
- reasoning: 1-2 sentences, terse and concrete, max 300 chars
- Never invent a suggestion not in the canonical list
- Never set confidence above 95
```

**User message:**
```
Dimension: <dim.label>

Canonical options:
1. United States
2. United Kingdom
...

Raw source value to match: "GB"
```

### `validateClaudeResponse(raw, canonicalLabels)`

Hard guard: if `suggestion` is not in `canonicalLabels`, set it to `null` and `confidence` to `0`. Prevents hallucinated matches from reaching the UI.

### Timeout handling

On 8s timeout, do **not** write to cache. Return `503 { error: "hint_timeout" }`. The client treats `503` as `error: true` and shows no hint — the user triages without AI assistance for that row.

---

## Server: `GET /api/triage/ai-hint`

Added to the session-gated block in `server.ts`.

**Route:** `GET /api/triage/ai-hint?dimId=X&raw=Y`

**Response:**
```typescript
interface AiHintResult {
  suggestion: string | null;
  confidence: number;   // 0-100
  reasoning:  string;
  cached:     boolean;
}
```

**Error responses:**
- `400` — missing `dimId` or `raw`
- `404` — dim not found
- `503` — Claude timeout or `ANTHROPIC_API_KEY` not set (client degrades gracefully)
- `502` — Claude API error

---

## Client: `useAiHint` hook

New file at `app/src/lib/use-ai-hint.ts`.

```typescript
export function useAiHint(
  dimId: string,
  raw: string,
  enabled: boolean,
): { hint: AiHint | null; loading: boolean; error: boolean }
```

**Behaviour:**
- `enabled = false` → no-op (used when no row is focused)
- 150ms debounce before firing the fetch — absorbs fast J/K navigation
- Module-level `sessionCache: Map<string, AiHint>` — survives remounts, re-focuses are instant
- `AbortController` cancels in-flight requests when `dimId`/`raw` changes
- On error or timeout: `{ hint: null, loading: false, error: true }` — UI shows nothing

**Hook placement:** Instantiated once at `TriageInner` level, driven by `cursor`:

```typescript
const aiHint = useAiHint(
  cursor?.dimId ?? "",
  cursor?.raw ?? "",
  cursor !== null,
);
```

Passed into `CrossDimInbox` and forwarded to the focused row only.

---

## UI: `TriageReasoningStrip`

New component at `app/src/components/TriageReasoningStrip.tsx`.

### Placement

The focused row switches from a pure grid to a flex column: existing 6-column grid on top, reasoning strip below. Unfocused rows are unchanged.

```tsx
<div /* row wrapper */>
  <div className={cx(COLS_CROSS, "py-2.5")}>
    {/* exact existing cell content */}
  </div>
  {focused && !r.target && (
    <TriageReasoningStrip hint={aiHint} />
  )}
</div>
```

`!r.target` — strip is hidden once the user has picked a value (decision made; reasoning no longer needed).

### Loading state

58%-width shimmer pill renders immediately on focus (before the 150ms debounce fires), using the existing `ak-shimmer` keyframe in `app-kit.css`. No fade-in; instant.

```tsx
<div className="mb-2 flex items-start gap-1.5 pl-[2px]">
  <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-pill bg-accent/30" aria-hidden />
  <div
    className="h-[10px] w-[58%] rounded-sm"
    style={{ /* ak-shimmer gradient animation */ }}
  />
</div>
```

### Loaded state

```tsx
<div className="mb-2 flex items-start gap-1.5 pl-[2px]" style={{ animation: "zz-rise var(--dur-slide) both" }}>
  <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-pill bg-accent/50" aria-hidden />
  <p className="font-mono text-[11px] italic leading-snug text-ink-2">
    {reasoning}
  </p>
</div>
```

6px accent dot as AI attribution signal. Italic mono at `text-[11px] text-ink-2` is visually subordinate to the `text-[13px] text-ink` raw value above it.

### Error state

Renders nothing — confidence bar alone is sufficient fallback.

### Confidence column

The confidence number gains a `title` attribute when reasoning is loaded:

```tsx
<span title={reasoning ? `${confidence}% · ${reasoning}` : `${confidence}%`}>
  {confidence}
</span>
```

The bar itself does not change.

---

## Integration: Parallel Data Path

The hint does **not** mutate `CrossRow.suggestion` or `CrossRow.confidence` in the store. Reasons:

1. Mutating would require a full `refreshDim()` or store splicing, causing grid re-renders
2. The existing `suggestion`/`confidence` fields are static pre-computed values loaded at boot; the AI hint is on-demand enrichment scoped to the focused row

**One exception:** `acceptCross` falls back to `hint?.suggestion` when `r.suggestion` is `null`:

```typescript
const acceptCross = (dimId: string, raw: string) => {
  const d = dimById.get(dimId);
  const v = d?.values.find((x) => x.value === raw);
  const suggestion = v?.suggestion ?? aiHint.hint?.suggestion;
  if (!suggestion) return;
  // ... existing logic
};
```

This means `A` works correctly even though the hint doesn't write back to the row data.

---

## Edge Cases

| Case | Behaviour |
|------|-----------|
| No canonical match | `suggestion: null`, `confidence: 0`, reasoning: "No match in canonical set." |
| Ambiguous value ("UK") | `suggestion:` most common historical match, `confidence: 30-50`, reasoning explicitly calls out ambiguity |
| AI wrong | Low confidence bar + falsifiable reasoning let user verify and reject with `S` or `M` |
| Very short raw ("1", "N/A") | Model relies on historical context; confidence stays low without strong signal |
| Long messy raw | Model uses semantic similarity; confidence penalty applied for extra qualifiers |
| Canonical set empty | Server returns `suggestion: null, confidence: 0, reasoning: "No canonical records exist yet."` |
| `ANTHROPIC_API_KEY` missing | Endpoint returns `503`; client shows no hint; triage fully functional without AI |
| Claude timeout (>8s) | Same as above — `503`, no cache write, graceful degradation |

---

## Trust Calibration

- **Confidence bar is the primary trust signal.** Green (≥90) = safe to accept. Orange (70-89) = review first. Red/thin (<70) = manual pick recommended.
- **Reasoning is falsifiable.** "ISO 3166-1 code. DE→Germany, FR→France" can be verified. "Seems right" cannot.
- **Staged review before commit.** Even high-confidence suggestions land as drafts. The footer review panel is the final human gate.
- **Settings toggle.** `AI Triage Suggestions` on/off in Settings preferences. Default: on. Stored in `preferences` table.
- **Never auto-accept.** No matter the confidence, `A` stages a draft — it never bypasses the commit step.

---

## Files Changed

| File | Type | Change |
|------|------|--------|
| `server/drizzle/schema.ts` | Edit | Add `aiHintCache` table definition |
| `server/drizzle/migrations/` | New | Migration for `ai_hint_cache` |
| `server/src/repo-ai-hint.ts` | New | `getAiHint`, `callClaude`, `validateClaudeResponse` |
| `server/src/server.ts` | Edit | Add `GET /api/triage/ai-hint` route |
| `server/src/repo-drafts.ts` | Edit | Prune stale hints after `commit()` |
| `server/src/env.ts` | Edit | Add `anthropicApiKey`, soft-fail when absent |
| `app/src/lib/use-ai-hint.ts` | New | `useAiHint` hook with debounce + session cache |
| `app/src/components/TriageReasoningStrip.tsx` | New | Shimmer + loaded + error states |
| `app/src/routes/Triage.tsx` | Edit | Wire hook, expand focused row, pass hint to accept handler |

---

## Out of Scope

- Fuzzy matching for the existing `suggestion` field (current scan-time logic) — left as `null`/`0`; AI is the first real implementation
- Batch pre-warming hints at scan time — future optimisation
- Feedback loop / acceptance rate tracking — future instrumentation
- Peer values / historical mapping context in the prompt — v2 enrichment once basic flow is validated
