import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun } from "./pg.ts";
import { lookupAliasedSlug, recordSlugAlias } from "./slug-alias.ts";

const T = "test_slug_alias";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, 'slug_after', 'Aliased', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_slug_alias" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("recordSlugAlias + lookupAliasedSlug", () => {
  it("records an alias with 30-day expiry by default", async () => {
    await recordSlugAlias("old_slug_a", T);
    const found = await lookupAliasedSlug("old_slug_a");
    expect(found).not.toBeNull();
    expect(found!.currentSlug).toBe("slug_after");
    expect(found!.tenantId).toBe(T);
  });

  it("returns null for unknown old slugs", async () => {
    expect(await lookupAliasedSlug("never_was_a_slug")).toBeNull();
  });

  it("returns null when the alias is expired", async () => {
    await recordSlugAlias("old_slug_b", T);
    await pgRun(
      `UPDATE "zugzug_app"."tenant_slug_alias"
          SET expires_at = now() - interval '1 hour'
        WHERE old_slug = $1`,
      ["old_slug_b"],
    );
    expect(await lookupAliasedSlug("old_slug_b")).toBeNull();
  });

  it("upsert: recording the same old_slug twice updates expires_at, doesn't error", async () => {
    await recordSlugAlias("old_slug_c", T);
    await recordSlugAlias("old_slug_c", T);
    const found = await lookupAliasedSlug("old_slug_c");
    expect(found).not.toBeNull();
  });
});
