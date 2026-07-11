# Reference data management, not entity resolution

During v0.3 direction exploration we mocked up three product shapes: (1) the shipped value-mapping curation tool, (2) governed reference tables (maintained lists with owner, draft → review → publish, history), and (3) entity resolution / golden records ("one trusted record per customer", duplicates inbox, survivorship). We decided Zugzug is 1 + 2 and that 3 stays permanently out of scope.

Reference tables are an incremental deepening of what exists — `dim_` tables already are maintained lists, and drafts/approval/audit already exist. Entity resolution is a different product with a probabilistic-matching core we don't have, in the enterprise MDM market (Tamr/Stibo/Reltio) the roadmap already lists as an explicit anti-goal. "Google-Sheets-like" describes the grid UX quality bar we aim for, not the product category.

## Consequences

- The `docs/mdm-duplicates-inbox.html` and `docs/mdm-oss-overview.html` mockups are discarded; `docs/mdm-reference-table.html` is the design reference for the reference-table surface.
- Positioning claims in the discarded mockups (single Go binary, Apache 2.0) were exploration artifacts — the stack remains Bun/TypeScript and the license remains MIT (a one-way door taken at v0.1).
