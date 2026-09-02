/**
 * Historical audit rows must still read plainly.
 *
 * The server wrote (and for older rows still stores) English-sentence action
 * codes carrying internal vocabulary: "Committed", "Warehouse synced",
 * "Auto-matched". Those rows are in the database forever, so the CLIENT has to
 * own the display copy — a server-side rename can never reach them.
 *
 * This is the regression test for the workspace/admin feed rendering them.
 */

import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { AuditTimeline } from "../src/components/AuditTimeline";
import { humanize } from "../src/lib/audit-format";
import type { AuditEntry } from "../src/store";

const BANNED =
  /\b(canonical|raw|triage|master|golden|commit(ted)?|staged?|sync(ed)?|resync|tenant|match(ed|ing)?|probe)\b/i;

/** Action + detail pairs exactly as older rows carry them in audit_log. */
const HISTORICAL: Array<{ action: string; detail: string }> = [
  { action: "Committed", detail: "12 values → analytics.map_channel · 3 rows recovered" },
  { action: "Committed mapping", detail: "→ web" },
  { action: "Warehouse synced", detail: "12 → analytics.map_channel" },
  { action: "Warehouse sync failed", detail: "12 → analytics.map_channel: connection refused" },
  {
    action: "Warehouse rollback sync",
    detail: "additive — rows added by the reverted version may remain; manual resync recommended",
  },
  { action: "Warehouse sync failed (rollback)", detail: "→ analytics.map_channel: timeout" },
  { action: "Auto-matched", detail: "3 values staged in channel (exact label match)" },
  // scan_failed leads its detail with the scheduler job's own name.
  { action: "scan_failed", detail: "auto-commit — connection lost (run: r_9)" },
  { action: "scan_failed", detail: "auto-stage-exact-matches — timeout (run: r_10)" },
];

const rows: AuditEntry[] = HISTORICAL.map((h, i) => ({
  id: `a${i}`,
  at: new Date("2026-08-01T10:00:00Z").toISOString(),
  user: { id: "u1", name: "Ada", initials: "AD" } as AuditEntry["user"],
  action: h.action,
  detail: h.detail,
}));

describe("historical audit rows", () => {
  test("no banned vocabulary reaches the screen", () => {
    const { container } = render(<AuditTimeline rows={rows} />);
    const text = container.textContent ?? "";
    const hit = text.match(BANNED);
    expect(hit?.[0], `rendered feed still says "${hit?.[0]}" in: ${text}`).toBeUndefined();
  });

  test("the phrase reads verb-first, not noun-first", () => {
    // "Warehouse synced" used to parse as verb="warehouse", noun="synced" —
    // "Ada warehouse synced". The subject is the actor; the verb comes next.
    const p = humanize(rows[2]!);
    expect(p.verb).toBe("updated");
    expect(p.noun).toBe("the warehouse");
    expect(p.kind).toBe("publish");
  });

  test("a bare single-word action is still translated", () => {
    // "Committed" does not match the two-part sentence regex at all and used to
    // fall through verbatim.
    expect(humanize(rows[0]!).verb).toBe("published");
  });

  test("system details written before the rename are cleaned too", () => {
    expect(humanize(rows[6]!).target).not.toMatch(BANNED);
    expect(humanize(rows[4]!).target).not.toMatch(BANNED);
  });

  test("details carrying user data are left alone", () => {
    // The mapped key is user data — never rewrite it.
    expect(humanize(rows[1]!).target).toBe("→ web");
    // Nor a source value that happens to contain one of the phrases we rewrite.
    const draft = { ...rows[0]!, action: "discard_draft", detail: "channel: staged in transit" };
    expect(humanize(draft).target).toBe("channel: staged in transit");
  });
});
