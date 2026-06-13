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

## MVP Configuration Approach (2026-06-13)

**Decision:** Environment variables for MVP; admin API endpoint in Phase 2.

**MVP Configuration Method:** Environment Variables
```bash
# Server startup loads these into workspace_config
OPENAI_API_KEY=sk-...
# Later: ANTHROPIC_API_KEY=... for v2
```

**How it works:**
- On server startup, bootstrap script reads `OPENAI_API_KEY` from `.env`
- Workspace admin sets `ai_enabled=true` and `ai_provider='openai'` in `workspace_config`
- Keys are fetched from `workspace_config` at request time
- No UI for key management in MVP (admin workflow: environment variable → Postgres directly)

**Spec compliance note:** This satisfies the requirement "Accept configuration via environment variables or admin API (no UI for MVP)". Environment variables are the chosen path for initial MVP setup.

**Phase 2 enhancement:** Add admin API endpoint to rotate keys securely without restart:
```
POST /api/admin/workspace/:workspaceId/ai-config
{ "ai_enabled": true, "ai_provider": "openai", "ai_api_key": "..." }
```

This keeps MVP simple (env vars only) while enabling future self-service key management.

---

## Implementation Status

- **Task 1: Decisions (this document)** — Complete
- Task 2: Schema migrations — Pending
- Task 3: AI provider abstraction — Pending
- Task 4–14: Core implementation — Pending

See `2026-06-13-ai-mapping-suggestions.md` for full implementation plan.
