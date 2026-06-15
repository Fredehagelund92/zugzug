import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  updateTenantLabel,
  WORKSPACE_COLORS,
  updateTenantColor,
  updateTenantSlug,
} from "./tenant.ts";
import { pgRun } from "./pg.ts";
import { lookupAliasedSlug } from "./slug-alias.ts";

describe("updateTenantLabel", () => {
  it("rejects empty label", async () => {
    await expect(updateTenantLabel("any", "")).rejects.toThrow(/empty/i);
  });
  it("rejects whitespace-only label", async () => {
    await expect(updateTenantLabel("any", "   ")).rejects.toThrow(/empty/i);
  });
});

describe("WORKSPACE_COLORS", () => {
  it("has 10 entries", () => {
    expect(WORKSPACE_COLORS).toHaveLength(10);
  });
  it("includes indigo as first entry", () => {
    expect(WORKSPACE_COLORS[0]).toBe("#6366f1");
  });
});

describe("updateTenantColor", () => {
  it("rejects an invalid hex", async () => {
    await expect(updateTenantColor("any", "#000000")).rejects.toThrow(/invalid color/i);
  });
  it("rejects empty string", async () => {
    await expect(updateTenantColor("any", "")).rejects.toThrow(/invalid color/i);
  });
});

describe("updateTenantSlug — alias hook", () => {
  const TID = "test_rename_hook";
  const OLD = "rename_hook_before";
  const NEW = "rename_hook_after";

  beforeAll(async () => {
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
       VALUES ($1, $2, 'Rename Hook', now()) ON CONFLICT DO NOTHING`,
      [TID, OLD],
    );
  });

  afterAll(async () => {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_slug_alias" WHERE tenant_id = $1`, [TID]).catch(
      () => {},
    );
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [TID]).catch(() => {});
  });

  it("records old slug → tenant alias when slug changes", async () => {
    await updateTenantSlug(OLD, NEW);
    const aliased = await lookupAliasedSlug(OLD);
    expect(aliased).not.toBeNull();
    expect(aliased!.currentSlug).toBe(NEW);
    expect(aliased!.tenantId).toBe(TID);
  });
});
