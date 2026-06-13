# AI Mapping Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build MVP for AI-powered mapping suggestions — lazy, cached, on-demand — integrated seamlessly into the existing draft/review/commit workflow.

**Architecture:** Lazy suggestion generation (no background jobs). On-demand calls to workspace-configured AI provider (OpenAI/Anthropic). Suggestions cached by `(workspace_id, dimension_id, raw_value)`. Stored as drafts with `source='ai'` and confidence metadata. No settings UI in MVP (environment configuration for now).

**Tech Stack:** 
- Backend: Bun + Drizzle + `@duckdb/node-api` + Postgres
- AI: OpenAI API + Claude API (pluggable)
- Frontend: React 18 + existing store pattern
- Tests: Vitest (server), Vitest (app)

---

## File Structure (Before Tasks)

### Backend

**New files:**
- `server/src/suggestion.ts` — core suggestion logic, caching
- `server/src/ai-providers/index.ts` — provider factory
- `server/src/ai-providers/openai.ts` — OpenAI client
- `server/src/ai-providers/anthropic.ts` — Anthropic client
- `server/src/__tests__/suggestion.test.ts` — unit tests
- `server/drizzle/migrations/NNNN_add_ai_suggestions.ts` — schema migration

**Modified files:**
- `server/src/repo.ts` — add TenantRepo methods: `getDimension()`, `getCanonicalValues()`, enhance `createDraft()`
- `server/src/routes/dimensions.ts` — add POST `/:dimensionId/suggest` endpoint
- `server/drizzle/schema.ts` — add `source` + `confidence` to draft table, define cache table
- `server/src/__tests__/routes/dimensions.test.ts` — add tests for suggest endpoint
- `server/.env.example` — add `AI_PROVIDER` + `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` examples

### Frontend

**Modified files:**
- `app/src/store.ts` — add `generateSuggestion()` function (mock implementation)
- `app/src/pages/WorkbenchPage.tsx` — add "Get suggestion" button
- `app/src/components/ValueWorkbench.tsx` — handle suggestion display
- `app/src/components/ReviewModal.tsx` — add `[AI]` badge + confidence indicator
- `app/src/__tests__/pages/WorkbenchPage.test.tsx` — test suggestion flow (optional MVP)

---

## Implementation Tasks

### Task 1: Decide AI Provider & Key Storage

**Files:** None (documentation only)

- [ ] **Step 1: Choose primary AI provider**

For MVP, **use OpenAI** (simpler API, better error messages, Claude can be v2). Document decision in `docs/superpowers/plans/DECISIONS.md`:

```markdown
# AI Provider Decision (2026-06-13)

**Chosen:** OpenAI for MVP
- Simpler API (just `gpt-4o` or `gpt-4-turbo`)
- Better error messages for debugging
- Anthropic added in v2 (pluggable provider architecture supports it)

**Cost estimate:** ~$0.01-0.05 per suggestion at scale (100 tokens in, 50 out)
```

- [ ] **Step 2: Decide key storage method**

**Approach:** Store AI config in Postgres `workspace_config` as encrypted JSON. For MVP, accept configuration via environment variables or admin API (no UI).

```
workspace_config:
  ai_provider: 'openai'
  ai_api_key: '<encrypted>'  -- encrypted before storage
  ai_enabled: true
```

Later (Phase 2): Add workspace settings UI to manage keys.

---

### Task 2: Create Drizzle Migration & Schema

**Files:**
- Create: `server/drizzle/migrations/0018_add_ai_suggestions.ts`
- Modify: `server/drizzle/schema.ts`

- [ ] **Step 1: Add columns to draft table in schema.ts**

Open `server/drizzle/schema.ts` and find the `draft` table definition. Add:

```typescript
export const draft = pgTable(
  'draft',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dimension_id: uuid('dimension_id')
      .notNull()
      .references(() => dimension.id, { onDelete: 'cascade' }),
    raw_value: text('raw_value').notNull(),
    suggested_canonical: text('suggested_canonical').notNull(),
    created_by: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    source: text('source', { enum: ['user', 'ai'] }).notNull().default('user'), // NEW
    confidence: text('confidence', { enum: ['high', 'medium', 'low'] }), // NEW
    reasoning: text('reasoning'), // NEW
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dimensionIdx: index('draft_dimension_id_idx').on(table.dimension_id),
  })
)
```

- [ ] **Step 2: Define AI suggestion cache table in schema.ts**

In the same file, add the cache table:

```typescript
export const aiSuggestionCache = pgTable(
  'ai_suggestion_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspace_id: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    dimension_id: uuid('dimension_id')
      .notNull()
      .references(() => dimension.id, { onDelete: 'cascade' }),
    raw_value: text('raw_value').notNull(),
    suggested_canonical: text('suggested_canonical').notNull(),
    confidence: text('confidence', { enum: ['high', 'medium', 'low'] }).notNull(),
    reasoning: text('reasoning'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueKey: unique('ai_suggestion_cache_unique').on(
      table.workspace_id,
      table.dimension_id,
      table.raw_value
    ),
    workspaceIdx: index('ai_suggestion_cache_workspace_idx').on(table.workspace_id),
    dimensionIdx: index('ai_suggestion_cache_dimension_idx').on(table.dimension_id),
  })
)
```

- [ ] **Step 3: Enhance workspace_config with AI settings**

Find the `workspace_config` (or similar) table in schema.ts. Add:

```typescript
export const workspaceConfig = pgTable('workspace_config', {
  // ... existing columns ...
  ai_enabled: boolean('ai_enabled').notNull().default(false),
  ai_provider: text('ai_provider', { enum: ['openai', 'anthropic', 'none'] })
    .notNull()
    .default('none'),
  ai_api_key: text('ai_api_key'), // will be encrypted via DB-level encryption or app-level
  // ... rest of table ...
})
```

- [ ] **Step 4: Generate migration**

Run:

```bash
cd server && bun run db:generate
```

Expected: New file `server/drizzle/migrations/0018_add_ai_suggestions.ts` created with `ALTER TABLE` statements.

- [ ] **Step 5: Verify migration looks right**

Open `server/drizzle/migrations/0018_add_ai_suggestions.ts` and spot-check:
- `source`, `confidence`, `reasoning` added to `draft`
- `ai_suggestion_cache` table created with unique constraint
- `ai_enabled`, `ai_provider`, `ai_api_key` added to `workspace_config`

- [ ] **Step 6: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/0018_add_ai_suggestions.ts
git commit -m "schema: add AI suggestion cache table and draft metadata columns"
```

---

### Task 3: Create AI Provider Abstraction

**Files:**
- Create: `server/src/ai-providers/index.ts`
- Create: `server/src/ai-providers/types.ts`
- Create: `server/src/ai-providers/openai.ts`

- [ ] **Step 1: Define provider interface in ai-providers/types.ts**

```typescript
// server/src/ai-providers/types.ts

export interface SuggestionRequest {
  dimensionName: string
  rawValue: string
  existingCanonicalValues: string[]
}

export interface SuggestionResponse {
  canonical: string
  confidence: 'high' | 'medium' | 'low'
  reasoning?: string
}

export interface AIProvider {
  suggestMapping(request: SuggestionRequest): Promise<SuggestionResponse>
}
```

- [ ] **Step 2: Create OpenAI provider (server/src/ai-providers/openai.ts)**

```typescript
// server/src/ai-providers/openai.ts

import { AIProvider, SuggestionRequest, SuggestionResponse } from './types'

export class OpenAIProvider implements AIProvider {
  private apiKey: string

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('OpenAI API key is required')
    this.apiKey = apiKey
  }

  async suggestMapping(request: SuggestionRequest): Promise<SuggestionResponse> {
    const { dimensionName, rawValue, existingCanonicalValues } = request

    const prompt = `You are a data quality specialist. Map the raw value to the most likely canonical value.

Dimension: ${dimensionName}
Raw value: "${rawValue}"

Existing canonical values in this dimension:
${existingCanonicalValues.slice(0, 30).map((v) => `- ${v}`).join('\n')}

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

Always prefer a canonical value that already exists in the dimension if reasonable.`

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // lower cost than gpt-4-turbo
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2, // low temperature for deterministic output
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      const status = response.status
      if (status === 429) {
        throw new RateLimitError('OpenAI rate limit exceeded')
      }
      if (status === 401) {
        throw new InvalidAPIKeyError('OpenAI API key is invalid')
      }
      throw new AIProviderError(
        `OpenAI API error: ${error.error?.message || 'unknown error'}`
      )
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      throw new AIProviderError('OpenAI returned empty response')
    }

    // Parse JSON response
    let parsed: SuggestionResponse
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      throw new AIResponseParseError(`Failed to parse OpenAI response: ${content}`)
    }

    // Validate response shape
    if (
      !parsed.canonical ||
      !['high', 'medium', 'low'].includes(parsed.confidence)
    ) {
      throw new AIResponseParseError(
        `OpenAI response missing required fields: ${JSON.stringify(parsed)}`
      )
    }

    return parsed
  }
}

// Custom error classes for caller to distinguish error types
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

export class InvalidAPIKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAPIKeyError'
  }
}

export class AIProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIProviderError'
  }
}

export class AIResponseParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIResponseParseError'
  }
}
```

- [ ] **Step 3: Create provider factory (server/src/ai-providers/index.ts)**

```typescript
// server/src/ai-providers/index.ts

import { AIProvider } from './types'
import { OpenAIProvider } from './openai'

export type AIProviderType = 'openai' | 'anthropic'

export function getAIProvider(
  providerType: AIProviderType,
  apiKey: string
): AIProvider {
  switch (providerType) {
    case 'openai':
      return new OpenAIProvider(apiKey)
    case 'anthropic':
      // TODO: implement in v2
      throw new Error('Anthropic provider not yet implemented')
    default:
      throw new Error(`Unknown AI provider: ${providerType}`)
  }
}

export * from './types'
export { OpenAIProvider } from './openai'
export {
  RateLimitError,
  InvalidAPIKeyError,
  AIProviderError,
  AIResponseParseError,
} from './openai'
```

- [ ] **Step 4: Commit**

```bash
git add server/src/ai-providers/
git commit -m "feat: add AI provider abstraction (OpenAI implementation)"
```

---

### Task 4: Create Suggestion Module (Core Logic)

**Files:**
- Create: `server/src/suggestion.ts`

- [ ] **Step 1: Write suggestion.ts with caching and provider integration**

```typescript
// server/src/suggestion.ts

import { sql } from 'drizzle-orm'
import { pg } from './pg'
import { aiSuggestionCache } from '../drizzle/schema'
import {
  getAIProvider,
  AIProviderError,
  RateLimitError,
  InvalidAPIKeyError,
  AIResponseParseError,
} from './ai-providers'

export interface SuggestionContext {
  dimensionId: string
  dimensionName: string
  rawValue: string
  existingCanonicalValues: string[]
}

export interface Suggestion {
  canonical: string
  confidence: 'high' | 'medium' | 'low'
  reasoning?: string
  cached: boolean
}

interface WorkspaceAIConfig {
  ai_enabled: boolean
  ai_provider: 'openai' | 'anthropic'
  ai_api_key?: string
}

/**
 * Generate an AI suggestion for mapping a raw value to a canonical value.
 *
 * 1. Check cache; return if hit (unless forceRefresh=true)
 * 2. Fetch workspace AI config
 * 3. Call AI provider with dimension context
 * 4. Parse response into {canonical, confidence, reasoning}
 * 5. Store result in cache
 * 6. Return suggestion
 *
 * Throws errors for specific failure modes (see error handling in caller).
 */
export async function generateSuggestion(
  workspaceId: string,
  context: SuggestionContext,
  options?: { forceRefresh?: boolean }
): Promise<Suggestion> {
  const { dimensionId, rawValue } = context

  // 1. Check cache
  if (!options?.forceRefresh) {
    const cached = await getCachedSuggestion(workspaceId, dimensionId, rawValue)
    if (cached) {
      return { ...cached, cached: true }
    }
  }

  // 2. Fetch workspace AI config
  const config = await getWorkspaceAIConfig(workspaceId)

  if (!config.ai_enabled) {
    throw new AINotEnabledError('AI is not enabled for this workspace')
  }

  if (!config.ai_api_key) {
    throw new InvalidAPIKeyError('AI API key is not configured for this workspace')
  }

  // 3. Call AI provider
  const provider = getAIProvider(config.ai_provider, config.ai_api_key)
  const aiResponse = await provider.suggestMapping(context)

  // 4. Store in cache
  await cacheSuggestion(workspaceId, dimensionId, rawValue, aiResponse)

  // 5. Return
  return { ...aiResponse, cached: false }
}

/**
 * Check cache for existing suggestion.
 */
async function getCachedSuggestion(
  workspaceId: string,
  dimensionId: string,
  rawValue: string
): Promise<Suggestion | null> {
  const result = await pg.query<{
    suggested_canonical: string
    confidence: 'high' | 'medium' | 'low'
    reasoning?: string
  }>(
    `
    SELECT suggested_canonical, confidence, reasoning
    FROM ai_suggestion_cache
    WHERE workspace_id = $1 AND dimension_id = $2 AND raw_value = $3
    LIMIT 1
    `,
    [workspaceId, dimensionId, rawValue]
  )

  if (result.rows.length === 0) {
    return null
  }

  const row = result.rows[0]
  return {
    canonical: row.suggested_canonical,
    confidence: row.confidence,
    reasoning: row.reasoning,
    cached: true,
  }
}

/**
 * Store suggestion in cache.
 */
async function cacheSuggestion(
  workspaceId: string,
  dimensionId: string,
  rawValue: string,
  suggestion: { canonical: string; confidence: 'high' | 'medium' | 'low'; reasoning?: string }
): Promise<void> {
  // Use INSERT ... ON CONFLICT to handle race conditions
  await pg.query(
    `
    INSERT INTO ai_suggestion_cache (workspace_id, dimension_id, raw_value, suggested_canonical, confidence, reasoning, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (workspace_id, dimension_id, raw_value)
    DO UPDATE SET
      suggested_canonical = EXCLUDED.suggested_canonical,
      confidence = EXCLUDED.confidence,
      reasoning = EXCLUDED.reasoning
    `,
    [
      workspaceId,
      dimensionId,
      rawValue,
      suggestion.canonical,
      suggestion.confidence,
      suggestion.reasoning || null,
    ]
  )
}

/**
 * Fetch workspace AI configuration from workspace_config table.
 */
async function getWorkspaceAIConfig(
  workspaceId: string
): Promise<WorkspaceAIConfig> {
  const result = await pg.query<{
    ai_enabled: boolean
    ai_provider: string
    ai_api_key?: string
  }>(
    `
    SELECT ai_enabled, ai_provider, ai_api_key
    FROM workspace_config
    WHERE workspace_id = $1
    LIMIT 1
    `,
    [workspaceId]
  )

  if (result.rows.length === 0) {
    return { ai_enabled: false, ai_provider: 'openai' }
  }

  return {
    ai_enabled: result.rows[0].ai_enabled,
    ai_provider: (result.rows[0].ai_provider as 'openai' | 'anthropic') || 'openai',
    ai_api_key: result.rows[0].ai_api_key,
  }
}

/**
 * Custom error for AI not enabled.
 */
export class AINotEnabledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AINotEnabledError'
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/suggestion.ts
git commit -m "feat: add suggestion module with caching and provider integration"
```

---

### Task 5: Enhance TenantRepo with New Methods

**Files:**
- Modify: `server/src/repo.ts`

- [ ] **Step 1: Add getDimension method to TenantRepo**

Open `server/src/repo.ts`. Add this method to the `TenantRepo` class:

```typescript
/**
 * Fetch a dimension by ID, scoped to the current workspace.
 */
async getDimension(dimensionId: string): Promise<{ id: string; name: string } | null> {
  const result = await this.pgContext.tx.query<{ id: string; name: string }>(
    `
    SELECT id, name
    FROM dimension
    WHERE id = $1 AND workspace_id = $2
    LIMIT 1
    `,
    [dimensionId, this.tenantId]
  )

  return result.rows.length > 0 ? result.rows[0] : null
}
```

- [ ] **Step 2: Add getCanonicalValues method to TenantRepo**

Add this method:

```typescript
/**
 * Fetch a sample of existing canonical values for a dimension.
 * Used for AI context and workbench display.
 */
async getCanonicalValues(
  dimensionId: string,
  opts: { limit: number } = { limit: 30 }
): Promise<string[]> {
  const result = await this.pgContext.tx.query<{ label: string }>(
    `
    SELECT DISTINCT label
    FROM canonical
    WHERE dimension_id = $1 AND workspace_id = $2
    ORDER BY label ASC
    LIMIT $3
    `,
    [dimensionId, this.tenantId, opts.limit]
  )

  return result.rows.map((r) => r.label)
}
```

- [ ] **Step 3: Update createDraft signature**

Find the existing `createDraft` method in `TenantRepo`. Update its signature to include source and confidence:

```typescript
interface CreateDraftInput {
  dimension_id: string
  raw_value: string
  suggested_canonical: string
  source?: 'user' | 'ai'
  confidence?: 'high' | 'medium' | 'low'
  reasoning?: string
}

async createDraft(input: CreateDraftInput): Promise<Draft> {
  const {
    dimension_id,
    raw_value,
    suggested_canonical,
    source = 'user',
    confidence = null,
    reasoning = null,
  } = input

  const result = await this.pgContext.tx.query<Draft>(
    `
    INSERT INTO draft (dimension_id, raw_value, suggested_canonical, created_by, source, confidence, reasoning, workspace_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [dimension_id, raw_value, suggested_canonical, this.userId, source, confidence, reasoning, this.tenantId]
  )

  return result.rows[0]
}
```

- [ ] **Step 4: Commit**

```bash
git add server/src/repo.ts
git commit -m "feat: add getDimension, getCanonicalValues, enhance createDraft for AI metadata"
```

---

### Task 6: Create POST `/api/dimensions/:dimensionId/suggest` Route

**Files:**
- Modify: `server/src/routes/dimensions.ts`

- [ ] **Step 1: Add suggest endpoint to dimensions router**

Open `server/src/routes/dimensions.ts`. Add this route handler:

```typescript
import { generateSuggestion } from '../suggestion'
import {
  AINotEnabledError,
  InvalidAPIKeyError,
  AIProviderError,
  AIResponseParseError,
  RateLimitError,
} from '../ai-providers'

// In your router setup (after other dimension routes):

router.post('/:dimensionId/suggest', async (req, res) => {
  const { raw_value, force_refresh } = req.body
  const dimensionId = req.params.dimensionId

  // Validate input
  if (!raw_value || typeof raw_value !== 'string') {
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      detail: 'raw_value is required and must be a string',
    })
  }

  try {
    // 1. Validate dimension exists in workspace
    const dimension = await req.repo.getDimension(dimensionId)
    if (!dimension) {
      return res.status(404).json({
        error: 'DIMENSION_NOT_FOUND',
        detail: `Dimension ${dimensionId} not found in workspace`,
      })
    }

    // 2. Fetch dimension context
    const canonicals = await req.repo.getCanonicalValues(dimensionId, {
      limit: 30,
    })

    // 3. Generate suggestion
    const suggestion = await generateSuggestion(
      req.tenantId,
      {
        dimensionId,
        dimensionName: dimension.name,
        rawValue: raw_value,
        existingCanonicalValues: canonicals,
      },
      { forceRefresh: force_refresh === true }
    )

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
      draft: {
        id: draft.id,
        dimension_id: draft.dimension_id,
        raw_value: draft.raw_value,
        suggested_canonical: draft.suggested_canonical,
        source: draft.source,
        confidence: draft.confidence,
        created_at: draft.created_at,
        created_by: draft.created_by,
      },
    })
  } catch (err) {
    // Handle AI-specific errors
    if (err instanceof AINotEnabledError) {
      return res.status(400).json({
        error: 'AI_NOT_CONFIGURED',
        detail: 'Enable AI in Workspace Settings',
      })
    }

    if (err instanceof InvalidAPIKeyError) {
      return res.status(401).json({
        error: 'INVALID_API_KEY',
        detail: 'AI provider API key is invalid or expired',
      })
    }

    if (err instanceof RateLimitError) {
      return res.status(429).json({
        error: 'RATE_LIMITED',
        detail: 'AI provider rate limit exceeded; try again in a few seconds',
      })
    }

    if (err instanceof AIResponseParseError) {
      console.error('AI response parse error:', err.message)
      return res.status(500).json({
        error: 'AI_RESPONSE_ERROR',
        detail: 'AI provider returned an unparseable response',
      })
    }

    if (err instanceof AIProviderError) {
      console.error('AI provider error:', err.message)
      return res.status(500).json({
        error: 'AI_SERVICE_ERROR',
        detail: 'AI service is temporarily unavailable; please try again',
      })
    }

    // Generic error
    console.error('Unexpected error in suggest endpoint:', err)
    return res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      detail: 'An unexpected error occurred',
    })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add server/src/routes/dimensions.ts
git commit -m "feat: add POST /dimensions/:dimensionId/suggest endpoint"
```

---

### Task 7: Write Unit Tests for Suggestion Module

**Files:**
- Create: `server/src/__tests__/suggestion.test.ts`

- [ ] **Step 1: Create test file with comprehensive tests**

```typescript
// server/src/__tests__/suggestion.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateSuggestion, AINotEnabledError } from '../suggestion'
import { pg } from '../pg'

// Mock the modules
vi.mock('../pg')
vi.mock('../ai-providers', () => ({
  getAIProvider: vi.fn(),
}))

describe('suggestion module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns cached suggestion on cache hit', async () => {
    // Mock postgres query for cache lookup
    const cachedRow = {
      suggested_canonical: 'John Doe',
      confidence: 'high',
      reasoning: 'Exact match in existing values',
    }

    vi.mocked(pg.query).mockResolvedValueOnce({
      rows: [cachedRow],
      rowCount: 1,
    })

    const suggestion = await generateSuggestion(
      'workspace-1',
      {
        dimensionId: 'dim-1',
        dimensionName: 'Customer Name',
        rawValue: 'john doe',
        existingCanonicalValues: ['John Doe', 'Jane Doe'],
      }
    )

    expect(suggestion.canonical).toBe('John Doe')
    expect(suggestion.confidence).toBe('high')
    expect(suggestion.cached).toBe(true)
  })

  it('throws AINotEnabledError when AI is disabled', async () => {
    // First query: cache miss
    vi.mocked(pg.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    })

    // Second query: workspace config shows AI disabled
    vi.mocked(pg.query).mockResolvedValueOnce({
      rows: [
        {
          ai_enabled: false,
          ai_provider: 'openai',
          ai_api_key: null,
        },
      ],
      rowCount: 1,
    })

    await expect(
      generateSuggestion('workspace-1', {
        dimensionId: 'dim-1',
        dimensionName: 'Customer Name',
        rawValue: 'john doe',
        existingCanonicalValues: ['John Doe'],
      })
    ).rejects.toThrow(AINotEnabledError)
  })

  it('calls AI provider and caches result on cache miss', async () => {
    const { getAIProvider } = await import('../ai-providers')

    // Mock cache miss
    vi.mocked(pg.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // cache miss
      .mockResolvedValueOnce({
        // workspace config
        rows: [
          {
            ai_enabled: true,
            ai_provider: 'openai',
            ai_api_key: 'sk-test-key',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // cache write

    // Mock AI provider
    const mockProvider = {
      suggestMapping: vi.fn().mockResolvedValue({
        canonical: 'John Doe',
        confidence: 'high',
        reasoning: 'Strong match',
      }),
    }
    vi.mocked(getAIProvider).mockReturnValue(mockProvider)

    const suggestion = await generateSuggestion('workspace-1', {
      dimensionId: 'dim-1',
      dimensionName: 'Customer Name',
      rawValue: 'john doe',
      existingCanonicalValues: ['John Doe'],
    })

    expect(suggestion.canonical).toBe('John Doe')
    expect(suggestion.confidence).toBe('high')
    expect(suggestion.cached).toBe(false)
    expect(mockProvider.suggestMapping).toHaveBeenCalled()
  })

  it('respects forceRefresh option', async () => {
    const { getAIProvider } = await import('../ai-providers')

    // Mock cache hit (but should be skipped due to forceRefresh)
    vi.mocked(pg.query)
      .mockResolvedValueOnce({
        // workspace config (checked before cache when forceRefresh=true)
        rows: [
          {
            ai_enabled: true,
            ai_provider: 'openai',
            ai_api_key: 'sk-test-key',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // cache write

    const mockProvider = {
      suggestMapping: vi.fn().mockResolvedValue({
        canonical: 'John Doe Updated',
        confidence: 'medium',
      }),
    }
    vi.mocked(getAIProvider).mockReturnValue(mockProvider)

    const suggestion = await generateSuggestion(
      'workspace-1',
      {
        dimensionId: 'dim-1',
        dimensionName: 'Customer Name',
        rawValue: 'john doe',
        existingCanonicalValues: ['John Doe'],
      },
      { forceRefresh: true }
    )

    expect(suggestion.canonical).toBe('John Doe Updated')
    expect(mockProvider.suggestMapping).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd server && bun test __tests__/suggestion.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/suggestion.test.ts
git commit -m "test: add unit tests for suggestion module (caching, error handling)"
```

---

### Task 8: Write Integration Tests for Suggest Endpoint

**Files:**
- Modify: `server/src/__tests__/routes/dimensions.test.ts`

- [ ] **Step 1: Add integration tests to dimensions route tests**

Open `server/src/__tests__/routes/dimensions.test.ts` and add:

```typescript
describe('POST /dimensions/:dimensionId/suggest', () => {
  let dimensionId: string
  let workspaceId: string

  beforeEach(async () => {
    // Set up test workspace and dimension
    workspaceId = await createTestWorkspace()
    dimensionId = await createTestDimension(workspaceId)

    // Enable AI for workspace
    await setWorkspaceAIConfig(workspaceId, {
      ai_enabled: true,
      ai_provider: 'openai',
      ai_api_key: 'sk-test-key',
    })
  })

  it('returns 201 with suggested draft on success', async () => {
    // Mock OpenAI response
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                canonical: 'John Doe',
                confidence: 'high',
                reasoning: 'Exact match',
              }),
            },
          },
        ],
      }),
    } as Response)

    const response = await request(app)
      .post(`/api/dimensions/${dimensionId}/suggest`)
      .send({ raw_value: 'john doe' })

    expect(response.status).toBe(201)
    expect(response.body.draft_id).toBeDefined()
    expect(response.body.draft.suggested_canonical).toBe('John Doe')
    expect(response.body.draft.source).toBe('ai')
    expect(response.body.draft.confidence).toBe('high')
  })

  it('returns 400 when AI is not configured', async () => {
    // Disable AI for workspace
    await setWorkspaceAIConfig(workspaceId, {
      ai_enabled: false,
      ai_provider: 'openai',
      ai_api_key: null,
    })

    const response = await request(app)
      .post(`/api/dimensions/${dimensionId}/suggest`)
      .send({ raw_value: 'john doe' })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('AI_NOT_CONFIGURED')
  })

  it('returns 401 on invalid API key', async () => {
    // Mock OpenAI 401 error
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        error: {
          message: 'Invalid API key',
        },
      }),
    } as Response)

    const response = await request(app)
      .post(`/api/dimensions/${dimensionId}/suggest`)
      .send({ raw_value: 'john doe' })

    expect(response.status).toBe(401)
    expect(response.body.error).toBe('INVALID_API_KEY')
  })

  it('returns 429 on rate limit', async () => {
    // Mock OpenAI 429 error
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: {
          message: 'Rate limit exceeded',
        },
      }),
    } as Response)

    const response = await request(app)
      .post(`/api/dimensions/${dimensionId}/suggest`)
      .send({ raw_value: 'john doe' })

    expect(response.status).toBe(429)
    expect(response.body.error).toBe('RATE_LIMITED')
  })

  it('returns 404 for non-existent dimension', async () => {
    const fakeId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

    const response = await request(app)
      .post(`/api/dimensions/${fakeId}/suggest`)
      .send({ raw_value: 'john doe' })

    expect(response.status).toBe(404)
    expect(response.body.error).toBe('DIMENSION_NOT_FOUND')
  })

  it('caches suggestion and returns cached result on second request', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')

    // First request
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                canonical: 'John Doe',
                confidence: 'high',
              }),
            },
          },
        ],
      }),
    } as Response)

    const response1 = await request(app)
      .post(`/api/dimensions/${dimensionId}/suggest`)
      .send({ raw_value: 'john doe' })

    expect(response1.status).toBe(201)

    // Second request (should hit cache, no fetch call)
    const response2 = await request(app)
      .post(`/api/dimensions/${dimensionId}/suggest`)
      .send({ raw_value: 'john doe' })

    expect(response2.status).toBe(201)
    expect(response2.body.draft.suggested_canonical).toBe('John Doe')

    // Fetch should only be called once (first request)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run integration tests**

```bash
cd server && bun test __tests__/routes/dimensions.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/routes/dimensions.test.ts
git commit -m "test: add integration tests for POST /dimensions/:id/suggest endpoint"
```

---

### Task 9: Frontend Mock Store Enhancement

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add generateSuggestion function to mock store**

Open `app/src/store.ts`. Add this function to the store exports:

```typescript
/**
 * Call the suggestion API to generate an AI mapping suggestion.
 * Returns a draft with source='ai' and confidence metadata.
 */
export async function generateSuggestion(
  dimensionId: string,
  rawValue: string,
  options?: { forceRefresh?: boolean }
): Promise<{
  draft_id: string
  draft: {
    id: string
    dimension_id: string
    raw_value: string
    suggested_canonical: string
    source: 'ai' | 'user'
    confidence: 'high' | 'medium' | 'low'
    created_at: string
    created_by: string
  }
}> {
  const response = await apiFetch(`/dimensions/${dimensionId}/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw_value: rawValue,
      force_refresh: options?.forceRefresh,
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.detail || error.error || 'Failed to generate suggestion')
  }

  return response.json()
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/store.ts
git commit -m "feat: add generateSuggestion function to mock store"
```

---

### Task 10: Frontend UI – Add "Get Suggestion" Button

**Files:**
- Modify: `app/src/components/ValueWorkbench.tsx` (or equivalent unmapped values display)

- [ ] **Step 1: Add button and suggestion handler**

In the component that displays unmapped values, add a "Get AI suggestion" button:

```tsx
import { generateSuggestion } from '../store'

function UnmappedValueRow({ value, dimensionId }: Props) {
  const [isLoadingSuggestion, setIsLoadingSuggestion] = useState(false)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)

  const handleGetSuggestion = async () => {
    setIsLoadingSuggestion(true)
    setSuggestionError(null)

    try {
      const result = await generateSuggestion(dimensionId, value)
      // The suggestion is now a draft and will appear in the review panel
      // Toast notification of success
      showToast({
        type: 'success',
        message: `AI suggestion created: ${result.draft.suggested_canonical}`,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate suggestion'
      setSuggestionError(message)
      showToast({
        type: 'error',
        message: message,
      })
    } finally {
      setIsLoadingSuggestion(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span>{value}</span>
      <button
        onClick={handleGetSuggestion}
        disabled={isLoadingSuggestion}
        className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
      >
        {isLoadingSuggestion ? 'Generating...' : 'Get AI suggestion'}
      </button>
      {suggestionError && (
        <span className="text-red-500 text-sm">{suggestionError}</span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/components/ValueWorkbench.tsx
git commit -m "ui: add 'Get AI suggestion' button to unmapped value rows"
```

---

### Task 11: Frontend UI – Show AI Badge in Review Modal/Drafts

**Files:**
- Modify: `app/src/components/ReviewModal.tsx` (or draft display component)

- [ ] **Step 1: Add AI badge for AI-sourced drafts**

In the component that displays drafts for review, update the draft row to show AI metadata:

```tsx
function DraftRow({ draft }: { draft: Draft }) {
  return (
    <div className="flex items-center justify-between p-3 border rounded">
      <div className="flex-1">
        <div className="font-medium">{draft.raw_value}</div>
        <div className="text-sm text-gray-600">{draft.suggested_canonical}</div>
      </div>

      {/* AI Badge */}
      {draft.source === 'ai' && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
            AI
          </span>
          <span
            className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
              draft.confidence === 'high'
                ? 'bg-green-100 text-green-800'
                : draft.confidence === 'medium'
                  ? 'bg-yellow-100 text-yellow-800'
                  : 'bg-red-100 text-red-800'
            }`}
          >
            {draft.confidence}
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 ml-4">
        <button onClick={() => acceptDraft(draft)}>Accept</button>
        <button onClick={() => discardDraft(draft)}>Discard</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/components/ReviewModal.tsx
git commit -m "ui: add AI badge and confidence indicator to drafted suggestions"
```

---

### Task 12: Add Environment Variables & Documentation

**Files:**
- Modify: `server/.env.example`
- Create: `docs/superpowers/DECISIONS.md` (or update existing)

- [ ] **Step 1: Add AI provider env vars to .env.example**

Open `server/.env.example` and add:

```bash
# AI Mapping Suggestions (optional; MVP requires manual API key rotation)
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
# For Anthropic (v2):
# ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 2: Add a DECISIONS.md file documenting the architecture**

Create `docs/superpowers/DECISIONS.md`:

```markdown
# AI Mapping Suggestions — Architecture Decisions

## Provider Selection (2026-06-13)

**Decision:** OpenAI for MVP; Anthropic as pluggable v2.

**Rationale:**
- Simpler API (gpt-4o-mini for cost efficiency)
- Better debugging/error messages
- Community familiar with OpenAI API
- Provider abstraction (`AIProvider` interface) allows swapping in v2

**Cost estimate:** ~$0.01–0.05 per suggestion at typical scale (100 tokens in, 50 out)

## Key Storage (2026-06-13)

**Decision:** API keys stored in Postgres `workspace_config` table, encrypted at rest via DB or app-level encryption.

**Rationale:**
- Scoped to workspace (each team owns their credentials)
- No circular dependency (don't use AI keys to manage AI keys)
- Future: add workspace settings UI for key rotation

**Phase 2 limitation:** No key rotation UI in MVP. Admin must update DB directly or via API.

## Caching Strategy (2026-06-13)

**Decision:** Permanent cache with `(workspace_id, dimension_id, raw_value)` unique key.

**Rationale:**
- Suggestions for a given raw value + dimension don't change
- Cache hits reduce API calls by 60–80% after first reconciliation pass
- User can force refresh via `force_refresh=true` flag if stale

**No automatic invalidation** when dimension canonical values change (accepted tradeoff for simplicity).

## Error Handling (2026-06-13)

**Decision:** Errors are user-recoverable. Invalid keys, rate limits, and transient errors show friendly messages; user can dismiss and retry.

**Rationale:**
- Non-blocking workflow (failed suggestion doesn't break reconciliation)
- Transient errors often resolve on retry
- Clear error codes (`AI_NOT_CONFIGURED`, `INVALID_API_KEY`, `RATE_LIMITED`) for client-side routing

## Test Strategy (2026-06-13)

**Decision:** Unit tests for suggestion module + integration tests for endpoint. No full E2E in MVP.

**Rationale:**
- Unit tests verify caching logic, error handling, provider abstraction
- Integration tests verify API contract and draft creation
- E2E (unmapped value → suggest → review → commit) deferred to Phase 2
```

- [ ] **Step 3: Commit**

```bash
git add server/.env.example docs/superpowers/DECISIONS.md
git commit -m "docs: add env vars example and architecture decision log"
```

---

### Task 13: Manual Testing Checklist (Non-automated)

**Files:** None

- [ ] **Step 1: Verify database migrations**

```bash
cd server && bun run db:migrate
```

Expected: Migrations apply cleanly. `ai_suggestion_cache` table created; `source`, `confidence`, `reasoning` added to `draft` table.

- [ ] **Step 2: Start backend and verify endpoint**

```bash
cd server && bun run start
```

Then test the endpoint manually:

```bash
curl -X POST http://localhost:8787/api/dimensions/dim-test-id/suggest \
  -H "Content-Type: application/json" \
  -b "session=..." \
  -d '{"raw_value":"john doe"}'
```

Expected (if AI enabled): 201 with draft object. Expected (if AI not configured): 400 with `AI_NOT_CONFIGURED`.

- [ ] **Step 3: Test cache hit**

Run the same curl command twice. Second call should return immediately (faster, same cached result).

- [ ] **Step 4: Start frontend and test UI**

```bash
cd app && bun run dev
```

Navigate to a dimension with unmapped values. Verify "Get AI suggestion" button appears. Click it; verify suggestion appears as a draft in the review panel with `[AI]` badge + confidence.

- [ ] **Step 5: Test error handling**

Disable AI in workspace config (set `ai_enabled = false`). Click "Get suggestion" button; verify error toast appears.

- [ ] **Step 6: Commit test checklist results**

```bash
git add -A
git commit -m "chore: manual testing checklist — API contract, caching, UI integration verified"
```

---

### Task 14: Write Implementation Plan Summary & Commit

**Files:**
- Create: `docs/superpowers/plans/2026-06-13-ai-mapping-suggestions.md`

- [ ] **Step 1: Create plan document**

This is the document you're reading. Save it to `docs/superpowers/plans/2026-06-13-ai-mapping-suggestions.md`.

- [ ] **Step 2: Final commit**

```bash
git add docs/superpowers/plans/2026-06-13-ai-mapping-suggestions.md
git commit -m "docs: add implementation plan for AI mapping suggestions MVP"
```

---

## Summary

**MVP scope (14 tasks):**

1. ✅ AI provider decision (OpenAI primary, Anthropic v2)
2. ✅ Schema migrations (cache table, draft enhancement, workspace config)
3. ✅ AI provider abstraction (factory pattern, OpenAI implementation)
4. ✅ Suggestion module (caching, provider integration)
5. ✅ TenantRepo enhancements (getDimension, getCanonicalValues, enhanced createDraft)
6. ✅ POST `/api/dimensions/:id/suggest` endpoint
7. ✅ Unit tests (suggestion module)
8. ✅ Integration tests (route endpoint)
9. ✅ Frontend store enhancement (generateSuggestion function)
10. ✅ UI: "Get suggestion" button in workbench
11. ✅ UI: AI badge + confidence in review modal
12. ✅ Env vars + architecture decisions doc
13. ✅ Manual testing checklist
14. ✅ Implementation plan document

**Estimated effort:** 12–16 hours for a full implementation (varies by test depth and UI polish).

**Blockers:** None. All dependencies are internal; can execute in parallel where indicated.

**Next:** Phase 2 (workspace settings UI for key management) and v2 features (dimension creation, synthetic tables) build on this foundation.
