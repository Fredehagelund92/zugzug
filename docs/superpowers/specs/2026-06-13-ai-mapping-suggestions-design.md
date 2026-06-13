# AI Mapping Suggestions Design

**Date:** 2026-06-13  
**Status:** Approved  
**Scope:** MVP for AI-integrated master data management — lazy, on-demand mapping suggestions with caching  
**Future:** Dimension creation and synthetic table generation (v2)

---

## Problem Statement

Users spend most time in the value reconciliation workbench, manually mapping unmapped raw values to canonical values. This is repetitive for common patterns. AI can suggest mappings, accelerating the workflow while keeping humans in control via review/approval.

**Constraints:**
- BYOK (bring your own key): each workspace provides their own AI API credentials
- Open-source: code must be clean, testable, and easy to extend
- Cost-conscious: minimize API calls via caching; users only pay for what they use
- Non-technical users: confidence levels must be human-friendly (High/Medium/Low, not percentages)

---

## Architecture Overview

AI suggestions follow a **lazy, cached, on-demand model**:

1. User navigates to an unmapped value in the workbench
2. User clicks "Get AI suggestion"
3. Backend fetches dimension context (canonical values + dimension name)
4. Backend calls the workspace's configured AI provider (OpenAI, Claude, etc.)
5. AI responds with a suggestion + confidence category
6. Suggestion is stored as a draft with `source='ai'` and `confidence` metadata
7. User reviews, modifies, or discards the suggestion (same as manual drafts)
8. Suggestions are cached by `(workspace_id, dimension_id, raw_value)` to avoid repeated calls

**Key principle:** AI suggestions integrate seamlessly into the existing draft/review/commit workflow. They're just another type of draft.

---

## Data Model

### Workspace AI Configuration

Add to `workspace_config` table (or new `workspace_ai_settings` if preferred):

```sql
workspace_id UUID PRIMARY KEY (FK → workspace)
ai_provider ENUM ('openai', 'anthropic', 'none') DEFAULT 'none'
ai_api_key TEXT (encrypted)
ai_enabled BOOLEAN DEFAULT FALSE
created_at TIMESTAMP
updated_at TIMESTAMP
```

**Rationale:** Each workspace owns its own AI credentials. Zugzug never sees or stores plaintext keys. Encryption via existing `@noble/hashes` or similar.

### Draft Table Enhancement

Add two nullable columns to `app.draft`:

```sql
source ENUM ('user', 'ai') DEFAULT 'user'
confidence ENUM ('high', 'medium', 'low') NULL  -- set only for AI suggestions
```

**Rationale:** Minimal schema change. Existing draft logic (review, approve, commit) unchanged. Audit trail automatically captures whether a mapping came from AI.

### Suggestion Cache

New table `app.ai_suggestion_cache`:

```sql
id UUID PRIMARY KEY
workspace_id UUID (FK → workspace)
dimension_id UUID (FK → dimension)
raw_value TEXT
suggested_canonical TEXT
confidence ENUM ('high', 'medium', 'low')
reasoning TEXT  -- optional; AI's explanation
created_at TIMESTAMP

UNIQUE(workspace_id, dimension_id, raw_value)
INDEX on (workspace_id, dimension_id)
```

**Rationale:** Cache hits prevent redundant API calls. Unique constraint ensures one cached result per value per dimension. Reasoning is stored for transparency (can be shown in UI later).

---

## Core Module: `server/src/suggestion.ts`

### Type Definitions

```typescript
type Confidence = 'high' | 'medium' | 'low'

interface SuggestionContext {
  dimensionId: string
  dimensionName: string
  rawValue: string
  existingCanonicalValues: string[]  // ~30 sample values for context
}

interface Suggestion {
  canonical: string
  confidence: Confidence
  reasoning?: string
  cached: boolean
}

interface AIProviderConfig {
  provider: 'openai' | 'anthropic'
  apiKey: string
}
```

### Main Export

```typescript
/**
 * Generate an AI suggestion for mapping a raw value to a canonical value.
 * 
 * 1. Checks cache; returns if hit (unless forceRefresh=true)
 * 2. Fetches workspace AI config
 * 3. Calls AI provider with dimension context
 * 4. Parses response into {canonical, confidence, reasoning}
 * 5. Stores result in cache
 * 6. Returns suggestion
 * 
 * Throws if AI is not enabled for the workspace.
 */
export async function generateSuggestion(
  workspaceId: string,
  context: SuggestionContext,
  options?: { forceRefresh?: boolean }
): Promise<Suggestion>
```

### AI Provider Integration

Delegated to a provider-specific client (separate from this module):

```typescript
// In suggestion.ts, import a provider factory
import { getAIProvider } from './ai-providers'

const client = getAIProvider(config.provider, config.apiKey)
const response = await client.suggestMapping(context)
```

**Provider implementations** (`server/src/ai-providers/`):
- `openai.ts` — call OpenAI API
- `anthropic.ts` — call Anthropic API
- Each implements a common interface: `suggestMapping(context) → Promise<{canonical, confidence, reasoning}>`

### Prompt Template

For both providers (adapted to their APIs):

```
You are a data quality specialist. Map the raw value to the most likely canonical value.

Dimension: [dimensionName]
Raw value: "[rawValue]"

Existing canonical values in this dimension:
- [canonical 1]
- [canonical 2]
- [canonical 3]
... (up to 30 examples)

Respond with valid JSON (no markdown, no extra text):
{
  "canonical": "the best matching canonical value (string)",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation (optional, <100 chars)"
}

Confidence guidelines:
- "high": exact match, clear spelling variant, or strong semantic match to existing values
- "medium": plausible but requires some interpretation or there's ambiguity
- "low": unclear, requires human domain knowledge, or unlikely to be correct

Always prefer a canonical value that already exists in the dimension if reasonable.
```

---

## API Contract

### Endpoint: POST `/api/dimensions/:dimensionId/suggest`

**Request:**
```json
{
  "raw_value": "string (required)",
  "force_refresh": "boolean (optional, default false)"
}
```

**Success Response (201 Created):**
```json
{
  "draft_id": "uuid",
  "draft": {
    "id": "uuid",
    "dimension_id": "uuid",
    "raw_value": "string",
    "suggested_canonical": "string",
    "source": "ai",
    "confidence": "high" | "medium" | "low",
    "created_at": "ISO8601",
    "created_by": "system"
  }
}
```

**Error Responses:**

| Status | Error | Detail |
|--------|-------|--------|
| 400 | `AI_NOT_CONFIGURED` | "Enable AI in Workspace Settings" |
| 401 | `INVALID_API_KEY` | "AI provider API key is invalid" |
| 402 | `RATE_LIMITED` | "AI provider rate limit exceeded; try again in N seconds" |
| 500 | `AI_SERVICE_ERROR` | "AI provider returned an error; please try again" |
| 400 | `DIMENSION_NOT_FOUND` | "Dimension does not exist in this workspace" |

---

## Integration Points

### Route Handler (`server/src/routes/dimensions.ts`)

```typescript
router.post('/:dimensionId/suggest', async (req, res) => {
  const { raw_value, force_refresh } = req.body
  const dimensionId = req.params.dimensionId

  // 1. Validate dimension exists in workspace
  const dimension = await req.repo.getDimension(dimensionId)
  if (!dimension) {
    return res.status(400).json({ error: 'DIMENSION_NOT_FOUND' })
  }

  // 2. Fetch dimension context
  const canonicals = await req.repo.getCanonicalValues(dimensionId, { limit: 30 })

  // 3. Generate suggestion
  let suggestion
  try {
    suggestion = await generateSuggestion(req.tenantId, {
      dimensionId,
      dimensionName: dimension.name,
      rawValue: raw_value,
      existingCanonicalValues: canonicals,
    }, { forceRefresh })
  } catch (err) {
    // Handle AI errors (see error handling section)
    return handleAISuggestionError(err, res)
  }

  // 4. Create draft with AI metadata
  const draft = await req.repo.createDraft({
    dimension_id: dimensionId,
    raw_value: raw_value,
    suggested_canonical: suggestion.canonical,
    source: 'ai',
    confidence: suggestion.confidence,
    reasoning: suggestion.reasoning,
  })

  // 5. Return draft
  return res.status(201).json({
    draft_id: draft.id,
    draft: serializeDraft(draft),
  })
})
```

### TenantRepo Enhancements

Add to `server/src/repo.ts`:

```typescript
/**
 * Fetch existing canonical values for a dimension (sample).
 * Used for AI context and for the workbench display.
 */
getDimension(dimensionId: string): Promise<Dimension | null>

/**
 * Fetch ~30 existing canonical values for a dimension.
 */
getCanonicalValues(dimensionId: string, opts: { limit: number }): Promise<string[]>

/**
 * Enhanced to accept source and confidence metadata.
 */
createDraft(data: {
  dimension_id: string
  raw_value: string
  suggested_canonical: string
  source: 'user' | 'ai'
  confidence?: 'high' | 'medium' | 'low'
  reasoning?: string
}): Promise<Draft>
```

### UI Integration (`app/src/`)

**Workbench changes:**
- In the unmapped values list, add a "Get AI suggestion" button per value
- Button is disabled if AI is not enabled for the workspace
- Clicking shows a loading spinner; on success, the suggestion appears as a new draft in the review panel
- Each AI-suggested draft shows a badge: `[AI] High confidence` or `[AI] Medium confidence`

**Review modal:**
- AI drafts are marked with the `[AI]` badge alongside the confidence level
- User can accept, modify, or discard (same as manual drafts)

**Settings (v2):**
- Workspace settings page: enable/disable AI, configure provider, enter API key
- Show API usage and cost estimation

---

## Error Handling & Resilience

### Error Cases

| Scenario | Response | User Experience |
|----------|----------|---|
| AI not enabled | 400 `AI_NOT_CONFIGURED` | Button disabled in UI with tooltip: "Enable AI in Workspace Settings" |
| Invalid/expired API key | 401 `INVALID_API_KEY` | Show error toast once; disable AI button; admin can fix in settings |
| Rate limit (429 from provider) | 402 `RATE_LIMITED` | Show error toast: "Rate limit exceeded. Try again in N seconds" |
| Transient AI error (5xx, timeout) | 500 `AI_SERVICE_ERROR` | Show error toast: "AI service unavailable. Please try again" |
| Malformed AI response | 500 `AI_RESPONSE_ERROR` | Log error; show error toast: "AI response parsing failed" |

### Retry Strategy

- **Rate limit (429):** Retry with exponential backoff (base 1s, max 3 attempts)
- **Transient 5xx:** Retry once with 1s delay
- **Permanent errors (4xx auth, malformed):** Fail immediately; user must retry manually or fix settings

---

## Caching Strategy

### Cache Key

```
(workspace_id, dimension_id, raw_value)
```

### TTL

Permanent (cache row is deleted only when dimension is deleted).

**Rationale:** Suggestions for a given raw value + dimension pair don't change unless the dimension is fundamentally altered. User can manually refresh via `force_refresh=true` if desired.

### Cache Invalidation

- **Dimension deleted:** cascading delete on `ai_suggestion_cache` rows
- **Canonical values updated:** No automatic invalidation. If the dimension's canonical values change, old suggestions may be stale. User can force refresh if needed (optional UI: show "Refresh" button next to cached suggestion).

### Cost Reduction

- Without cache: every user who reconciles a value makes an API call (N users × 10,000 values = 10M calls)
- With cache: first user pays; subsequent users get free cached result
- **Expected reduction:** 60–80% fewer API calls

---

## Testing Strategy

### Unit Tests (`server/src/__tests__/suggestion.test.ts`)

- Mock AI provider; test suggestion generation logic
- Test cache hits and misses
- Test confidence parsing
- Test error handling (malformed responses, etc.)

### Integration Tests (`server/src/__tests__/routes/dimensions.test.ts`)

- Mock AI provider
- Test endpoint contract (success and error cases)
- Test draft creation with AI metadata
- Test draft retrieval (verify `source` and `confidence` are persisted)

### E2E (optional, phase 2)

- Test full workflow: unmapped value → suggest → review → commit
- Test confidence badges in UI

---

## Future Extensions

This design is foundational for v2 features:

### Dimension Creation from Prompt (v2)

```
POST /api/dimensions
{
  "name": "Tech Companies",
  "ai_prompt": "Generate the top 100 publicly traded technology companies by market cap, including company name and ticker"
}
```

Reuse `generateSuggestion` logic + cache. New endpoint generates multiple suggestions in batch.

### Synthetic Table Generation (v2)

```
POST /api/tables/generate
{
  "schema": [{name: "company", type: "string"}, {name: "stock_value", type: "float"}],
  "ai_prompt": "Generate 50 realistic tech companies with stock values"
}
```

Similar pattern: fetch context, call AI, store results, cache.

### Multi-Provider Support

Already supported: `suggestion.ts` is provider-agnostic. Adding a new provider is adding a new file to `ai-providers/`.

---

## Rollout Plan

1. **Phase 1 (MVP):** Lazy suggestions, caching, BYOK. No UI for settings yet; API key via ENV or admin endpoint.
2. **Phase 2:** Workspace settings UI (enable/disable, key rotation, usage stats).
3. **Phase 3:** Dimension creation + synthetic tables.
4. **Phase 4:** Multi-provider support, confidence-based routing (low-confidence → human queue).

---

## Success Criteria

- ✅ Suggestion generation completes in <1s (99th percentile)
- ✅ Cache reduces API calls by >60% on repeated values
- ✅ Error handling is graceful; failed suggestions don't break the workbench
- ✅ Audit trail captures AI-generated mappings (`draft.source = 'ai'`)
- ✅ Code is testable, documented, and open-source friendly
- ✅ Users can distinguish AI suggestions from manual ones (badge + confidence)
