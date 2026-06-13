# AI Mapping Suggestions — Architecture Decisions

**Date:** 2026-06-13  
**Status:** Approved  
**Scope:** MVP for AI-powered mapping suggestions

---

## Provider Selection (2026-06-13)

**Decision:** OpenAI for MVP; Anthropic as pluggable v2.

**Chosen Provider:** OpenAI
- Model: `gpt-4o-mini` (cost-efficient, high quality)
- API: Well-documented, simpler contract than some alternatives
- Error messages: Clear and actionable for debugging

**Why OpenAI for MVP:**
- Simpler API (single endpoint, predictable response format)
- Better debugging/error messages for production support
- Community familiar with OpenAI API (easier onboarding for team)
- Cost-efficient for this use case ($0.01–0.05 per suggestion)
- Provider abstraction (`AIProvider` interface) already designed for swapping in v2

**Deferred to v2:** Anthropic
- Will implement as pluggable alternative via `ai-providers/anthropic.ts`
- Triggered by workspace config: `ai_provider = 'anthropic'`
- No changes to core `suggestion.ts` logic required (provider-agnostic)

**Cost Estimate:** ~$0.01–0.05 per suggestion at typical scale
- Typical input: ~100 tokens (dimension context + 30 sample values)
- Typical output: ~50 tokens (suggestion + confidence + reasoning)
- OpenAI pricing: `gpt-4o-mini` at $0.00015/input token, $0.0006/output token
- Calculation: (100 × $0.00015) + (50 × $0.0006) = $0.015 + $0.03 = **~$0.045 per call**

---

## Key Storage (2026-06-13)

**Decision:** API keys stored in Postgres `workspace_config` table, encrypted at rest.

**Storage Location:** `workspace_config` table
```sql
ai_enabled BOOLEAN DEFAULT FALSE
ai_provider TEXT (enum: 'openai', 'anthropic', 'none') DEFAULT 'none'
ai_api_key TEXT  -- encrypted via application or DB-level encryption
```

**Why Postgres (not Vault/Secrets Manager):**
- Scoped per workspace (each team owns their own credentials)
- Single catalog (aligns with CLAUDE.md hard rules: all app state in Postgres)
- No external dependency (reduces operational complexity)
- Future: easy to implement key rotation UI in workspace settings

**Encryption Strategy:**
- At-rest encryption via database encryption (e.g., Postgres `pgcrypto` or application-level encryption)
- In-transit: HTTPS only
- In-memory: Decrypted only when calling AI provider; never logged or cached unencrypted

**No circular dependency:** Zugzug never uses AI to manage or validate AI keys. Keys are static per workspace (set by admin or via API).

**Phase 2 limitation:** MVP has no UI for key rotation. Admin must:
- Update `workspace_config.ai_api_key` directly via Postgres, OR
- Use a future admin API endpoint to rotate keys securely

Future (Phase 2): Add workspace settings UI to manage keys, test provider connectivity, view API usage.

---

## Caching Strategy (2026-06-13)

**Decision:** Permanent cache with `(workspace_id, dimension_id, raw_value)` unique key.

**Cache Table:** `ai_suggestion_cache`
```sql
id UUID PRIMARY KEY
workspace_id UUID
dimension_id UUID
raw_value TEXT
suggested_canonical TEXT
confidence TEXT (enum: 'high', 'medium', 'low')
reasoning TEXT (optional)
created_at TIMESTAMP
created_at TIMESTAMP
UNIQUE(workspace_id, dimension_id, raw_value)
```

**Why Permanent Cache:**
- Suggestions for a given raw value + dimension pair don't change
- Cache hits eliminate API calls for repeated reconciliation (same value, same dimension)
- Expected reduction: 60–80% fewer API calls after first pass through dimension

**User Control:** Force refresh via `force_refresh=true` flag if suggestion is stale
```
POST /api/dimensions/:dimensionId/suggest
{ "raw_value": "...", "force_refresh": true }
```

**Cache Invalidation:**
- Dimension deleted → cascading delete on cache rows (via `ON DELETE CASCADE`)
- Canonical values updated → **no automatic invalidation** (accepted tradeoff for simplicity)
  - Rationale: Suggestions are "good enough" suggestions, not definitive mappings
  - User can manually refresh if needed

**No TTL:** Cache rows persist indefinitely (database cleanup via archival jobs, if needed).

---

## Error Handling (2026-06-13)

**Decision:** Errors are user-recoverable. Non-blocking workflow.

**Error Classification:**

| Error | HTTP Status | Code | User Message | Recovery |
|-------|-------------|------|--------------|----------|
| AI not enabled | 400 | `AI_NOT_CONFIGURED` | "Enable AI in Workspace Settings" | Admin enables AI + sets key |
| Invalid/expired API key | 401 | `INVALID_API_KEY` | "AI provider API key is invalid or expired" | Admin updates key in workspace config |
| Rate limit exceeded | 429 | `RATE_LIMITED` | "AI rate limit exceeded; try again in a few seconds" | Retry after delay |
| Provider error (5xx, timeout) | 500 | `AI_SERVICE_ERROR` | "AI service temporarily unavailable; please try again" | Retry manually |
| Malformed response | 500 | `AI_RESPONSE_ERROR` | "AI returned an unparseable response" | Log for debugging; user retries |

**Retry Strategy:**
- **Rate limit (429):** Exponential backoff, max 3 attempts (1s, 2s, 4s)
- **Transient 5xx:** Retry once with 1s delay
- **Permanent errors (4xx auth, 400 invalid):** Fail immediately; user retries manually or fixes config

**Non-blocking:** Failed suggestion doesn't prevent user from manually creating draft or reconciling via other methods.

---

## Why This Architecture

**Design principles:**
1. **Lazy, on-demand:** No background jobs. Suggestions generated when user clicks button.
2. **Cached, cost-efficient:** Permanent cache reduces API calls by 60–80%.
3. **Workspace-scoped:** Each team manages their own credentials and enable/disable.
4. **Provider-agnostic:** Core logic is provider-independent; new providers added as isolated modules.
5. **User-focused:** Confidence levels (High/Medium/Low) are human-friendly, not algorithmic scores.
6. **Non-blocking:** Failed suggestions don't break the reconciliation workflow.

**Tradeoffs accepted in MVP:**
- No key rotation UI (deferred to Phase 2)
- No automatic cache invalidation (user can force refresh)
- No multi-provider switching in UI (currently config-only)
- No usage stats or cost tracking (deferred to Phase 2)

---

## Success Criteria

- ✅ Suggestions generated in <1 second (cached hits much faster)
- ✅ Cache reduces API calls by >60% on repeated values
- ✅ Error handling is graceful; failed suggestions don't block reconciliation
- ✅ Audit trail captures AI-generated mappings (`draft.source = 'ai'`, `draft.confidence`)
- ✅ Code is testable, documented, and extensible
- ✅ Users can distinguish AI suggestions from manual ones (badge + confidence indicator)

---

## Implementation Status

- **Task 1: Decisions (this document)** — Complete
- Task 2: Schema migrations — Pending
- Task 3: AI provider abstraction — Pending
- Task 4–14: Core implementation — Pending

See `2026-06-13-ai-mapping-suggestions.md` for full implementation plan.
