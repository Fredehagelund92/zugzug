import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NoTablesYet } from "../components/NoTablesYet";
import { TableTabStrip } from "../components/TableTabStrip";
import { TablePane } from "../components/TablePane";
import { useDimensions, useSources } from "../store";
import { useOpenTabs, dimIdFromTabId } from "../lib/open-tabs";
import { useCreateTableModal } from "../lib/create-table-modal";
import { availableModes, type Mode } from "../lib/available-modes";
import { foldUrlMode, readStoredMode, writeStoredMode } from "../lib/tab-mode";

/* Tables — the master-record workbench, now multi-tab. The route owns the URL
   contract (?open=a,b,c&active=<id> + legacy ?dimId=) and the tab strip. Each
   open tab mounts its own <TablePane> with an isolated UndoStackProvider; only
   the active pane is visible (CSS hide) so per-pane React state survives
   tab switches without a coordination layer. */

export function MasterTables() {
  const dims = useDimensions();
  const [searchParams, setSearchParams] = useSearchParams();
  const { tabs, activeId: activeTabId, openTab } = useOpenTabs();
  const create = useCreateTableModal();

  // Mount-only URL → state fold. Honors legacy ?dimId=<id> from old palette
  // links + bookmarks. New contract is ?open=a,b,c&active=<dimId>.
  const didInitFromUrl = useRef(false);
  useEffect(() => {
    if (didInitFromUrl.current) return;
    didInitFromUrl.current = true;
    const legacyDim = searchParams.get("dimId");
    const openParam = searchParams.get("open");
    const activeParam = searchParams.get("active");
    if (legacyDim && dims.some((d) => d.id === legacyDim)) {
      openTab(legacyDim);
      return;
    }
    if (openParam) {
      for (const did of openParam.split(",").filter(Boolean)) {
        if (dims.some((d) => d.id === did)) openTab(did);
      }
    }
    if (activeParam && dims.some((d) => d.id === activeParam)) {
      openTab(activeParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback so the page is never blank when the user has tables but no
  // session-restored tabs (first visit on a clean profile).
  useEffect(() => {
    if (!didInitFromUrl.current) return;
    if (tabs.length === 0 && dims.length > 0) {
      openTab(dims[0].id);
    }
  }, [tabs.length, dims, openTab]);

  useEffect(() => {
    if (!didInitFromUrl.current) return;
    const next = new URLSearchParams(searchParams);
    next.delete("dimId");
    if (tabs.length > 0) {
      next.set("open", tabs.map((t) => t.dimId).join(","));
    } else {
      next.delete("open");
    }
    if (activeTabId) {
      next.set("active", dimIdFromTabId(activeTabId));
    } else {
      next.delete("active");
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [tabs, activeTabId, searchParams, setSearchParams]);

  const dimById = useMemo(() => new Map(dims.map((d) => [d.id, d])), [dims]);

  // Per-tab mode state. Keyed by dimId so tab switches don't clobber a pane's
  // chosen mode. Mount fold reads ?mode= for the active tab once; thereafter,
  // user-driven mode changes flow through onModeChange (state + localStorage),
  // and the tab-switch effect mirrors the active tab's mode back into the URL.
  const sources = useSources();
  const [perTabMode, setPerTabMode] = useState<Record<string, Mode>>({});

  const foldedDimsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeTabId) return;
    const dimId = dimIdFromTabId(activeTabId);
    if (foldedDimsRef.current.has(dimId)) return;
    const dim = dimById.get(dimId);
    if (!dim) return;
    const modes = availableModes(dim, sources);
    const folded = foldUrlMode(searchParams, dimId, modes);
    setPerTabMode((cur) => ({ ...cur, [dimId]: folded }));
    foldedDimsRef.current.add(dimId);
  }, [activeTabId, dimById, sources, searchParams]);

  const onModeChange = useCallback((dimId: string, m: Mode) => {
    setPerTabMode((cur) => ({ ...cur, [dimId]: m }));
    writeStoredMode(dimId, m);
  }, []);

  // When the active tab changes (or its mode changes), sync ?mode= in the URL.
  // Drop ?value= whenever we're not in match mode — value is only meaningful
  // for the match body's cursor. Gate on the fold so we don't fire before
  // foldUrlMode has populated perTabMode and accidentally strip a fresh ?value=
  // from a deep-link before the cursor reads it.
  useEffect(() => {
    if (!activeTabId) return;
    const dimId = dimIdFromTabId(activeTabId);
    if (!foldedDimsRef.current.has(dimId)) return;
    const dim = dimById.get(dimId);
    if (!dim) return;
    const modes = availableModes(dim, sources);
    const mode = perTabMode[dimId] ?? readStoredMode(dimId, modes);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (mode !== "records") next.set("mode", mode);
        else next.delete("mode");
        if (mode !== "match") next.delete("value");
        return next;
      },
      { replace: true },
    );
  }, [activeTabId, perTabMode, dimById, sources, setSearchParams]);

  if (dims.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[var(--wide)] p-8">
        <NoTablesYet from="tables" onCreateRequested={create.open} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TableTabStrip onCreateRequested={create.open} />

      <div className="relative flex-1 min-h-0">
        {tabs.map((tab) => {
          const dim = dimById.get(tab.dimId);
          if (!dim) return null;
          const isActive = tab.id === activeTabId;
          const modes = availableModes(dim, sources);
          const mode: Mode = perTabMode[tab.dimId] ?? readStoredMode(tab.dimId, modes);
          return (
            <div
              key={tab.id}
              hidden={!isActive}
              className="absolute inset-0 flex flex-col min-h-0"
            >
              <TablePane
                dim={dim}
                isActive={isActive}
                mode={mode}
                modes={modes}
                onModeChange={(m) => onModeChange(tab.dimId, m)}
              />
            </div>
          );
        })}
        {tabs.length === 0 && (
          <div className="grid place-items-center px-8 py-20 text-center font-mono text-[12px] text-ink-3">
            no table open — pick one from the sidebar, or press ⌘K
          </div>
        )}
      </div>
    </div>
  );
}
