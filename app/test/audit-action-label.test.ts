import { describe, expect, test } from "vitest";
import { actionLabel } from "../src/lib/audit-format";

describe("actionLabel", () => {
  // The admin Activity "Type" picker offered raw action codes as menu options,
  // putting banned vocabulary (CLAUDE.md §5) straight on screen.
  test("translates the codes that carry internal vocabulary", () => {
    expect(actionLabel("Committed mapping")).toBe("Published mapping");
    expect(actionLabel("Warehouse synced")).toBe("Warehouse updated");
    expect(actionLabel("Warehouse sync failed")).toBe("Warehouse update failed");
    expect(actionLabel("impersonate_start")).toBe("Opened a workspace as admin");
    expect(actionLabel("admin.tenant.label_update")).toBe("Renamed workspace");
  });

  test("unknown codes degrade to their own words", () => {
    expect(actionLabel("scan_failed")).toBe("Scan failed");
    expect(actionLabel("warehouse.database.add")).toBe("Warehouse database add");
    expect(actionLabel("field.displayFields.update")).toBe("Field display fields update");
    expect(actionLabel("Added record")).toBe("Added record");
  });

  test("no label carries a banned word", () => {
    const banned =
      /\b(canonical|raw|triage|master|golden|commit(ted)?|staged|sync(ed)?|tenant|matching|probe)\b/i;
    const codes = [
      "Committed",
      "Committed mapping",
      "Warehouse synced",
      "Warehouse sync failed",
      "Warehouse rollback sync",
      "impersonate_start",
      "admin.tenant.label_update",
      "workspace.rename",
      "discard_draft",
      "scan_failed",
    ];
    for (const c of codes) expect(actionLabel(c)).not.toMatch(banned);
  });
});
