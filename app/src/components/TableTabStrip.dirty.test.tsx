/**
 * The tab's unpublished-drafts dot must track what publish would actually fold:
 * a table whose only drafts were rejected has nothing waiting, so it must not
 * sit there marked dirty forever while the publish state says "up to date".
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Draft } from "../store";

const drafts: Record<string, Draft> = {};

vi.mock("../store", () => ({
  useRefTables: () => [{ id: "country", refTable: "Country", color: null, record: [], fields: [] }],
  useDrafts: () => drafts,
  useCanEdit: () => true,
  deleteRefTable: vi.fn(),
}));

vi.mock("../lib/open-tabs", () => ({
  useOpenTabs: () => ({
    tabs: [{ id: "tables:country", refTableId: "country" }],
    activeId: "tables:country",
    openTab: vi.fn(),
    closeTab: vi.fn(),
    focusTab: vi.fn(),
  }),
}));

const { TableTabStrip } = await import("./TableTabStrip");

function draft(status: Draft["status"], targetKey: string | null): Draft {
  return {
    refTableId: "country",
    raw: "Danmark",
    status,
    targetLabel: "Denmark",
    targetKey,
    user: { id: "u1", name: "U", initials: "U" },
    at: "now",
    createdAt: new Date().toISOString(),
    source: "user",
    confidence: null,
    reasoning: null,
    rejectedReason: null,
    rejectedBy: null,
  };
}

function renderWith(d: Record<string, Draft>) {
  cleanup();
  for (const k of Object.keys(drafts)) delete drafts[k];
  Object.assign(drafts, d);
  render(<TableTabStrip />);
}

describe("tab unpublished-drafts dot", () => {
  it("shows for a draft publish would fold", () => {
    renderWith({ a: draft("mapped", "denmark") });
    expect(screen.queryByLabelText("unpublished drafts")).toBeInTheDocument();
  });

  it("stays off when the only draft was rejected", () => {
    renderWith({ a: draft("rejected", "denmark") });
    expect(screen.queryByLabelText("unpublished drafts")).not.toBeInTheDocument();
  });

  it("stays off for a mapped draft with no target", () => {
    renderWith({ a: draft("mapped", null) });
    expect(screen.queryByLabelText("unpublished drafts")).not.toBeInTheDocument();
  });
});
