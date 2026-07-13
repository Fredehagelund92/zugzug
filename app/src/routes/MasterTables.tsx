import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NoTablesYet } from "../components/NoTablesYet";
import { TableTabStrip } from "../components/TableTabStrip";
import { TablePane } from "../components/TablePane";
import { useDimensions, useSources, useCanEdit } from "../store";
import { useOpenTabs, dimIdFromTabId } from "../lib/open-tabs";
import { useCreateTableModal } from "../lib/create-table-modal";
import { availableModes, type Mode } from "../lib/available-modes";
import { foldUrlMode, readStoredMode, writeStoredMode } from "../lib/tab-mode";

/* Tables — the master-record workbench, now multi-tab. The route owns the URL
   contract (?open=a,b,c&active=<id>) and the tab strip. Each
   open tab mounts its own <TablePane> with an isolated UndoStackProvider; only
   the active pane is visible (CSS hide) so per-pane React state survives
   tab switches without a coordination layer. */

export function MasterTables() {
  const dims = useDimensions();
  const [searchParams, setSearchParams] = useSearchParams();
  const { tabs, activeId: activeTabId, openTab } = useOpenTabs();
  const create = useCreateTableModal();
  const canEdit = useCanEdit();

  // URL → state fold, run once — but only after the store has delivered the
  // table list. initStore() is fire-and-forget (TenantLayout), so on a cold
  // profile this route mounts with dims=[] and a mount-only fold would drop
  // every deep-linked tab; the URL writer below stays gated until the fold
  // lands, so ?open/?active survive the wait.
  // A workspace with no tables never folds — there is nothing to open, and
  // NoTablesYet renders regardless.
  const didInitFromUrl = useRef(false);
  // Whether the URL fold opened any tab. The blank-page fallback below runs in
  // the same commit with a stale (pre-fold) `tabs` capture, so without this
  // gate it would open dims[0] AFTER the fold and steal active from a deep link.
  const urlOpenedTab = useRef(false);
  useEffect(() => {
    if (didInitFromUrl.current) return;
    if (dims.length === 0) return;
    didInitFromUrl.current = true;
    const openParam = searchParams.get("open");
    const activeParam = searchParams.get("active");
    if (openParam) {
      for (const did of openParam.split(",").filter(Boolean)) {
        if (dims.some((d) => d.id === did)) {
          openTab(did);
          urlOpenedTab.current = true;
        }
      }
    }
    if (activeParam && dims.some((d) => d.id === activeParam)) {
      openTab(activeParam);
      urlOpenedTab.current = true;
    }
  }, [dims, searchParams, openTab]);

  // Fallback so the page is never blank when the user has tables but no
  // session-restored tabs (first visit on a clean profile).
  useEffect(() => {
    if (!didInitFromUrl.current || urlOpenedTab.current) return;
    if (tabs.length === 0 && dims.length > 0) {
      openTab(dims[0].id);
    }
  }, [tabs.length, dims, openTab]);

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

  // Single URL writer for every param this route manages (open/active/mode/
  // value). react-router's functional setSearchParams still computes from the
  // render-captured params, so two competing effect writers clobber each
  // other's params — one writer that rewrites all of them from current state
  // makes last-write-wins correct by construction. Drop ?value= whenever
  // we're not in match mode; gate mode/value on the fold so a deep-link's
  // fresh ?value= isn't stripped before the cursor reads it.
  useEffect(() => {
    if (!didInitFromUrl.current) return;
    // Base on the live URL, not react-router's render-captured params — a
    // stale capture from an earlier commit would silently drop params written
    // by a more recent run of this same effect.
    const next = new URLSearchParams(window.location.search);
    if (tabs.length > 0) {
      next.set("open", tabs.map((t) => t.dimId).join(","));
    } else {
      next.delete("open");
    }
    if (activeTabId) {
      const dimId = dimIdFromTabId(activeTabId);
      next.set("active", dimId);
      const dim = dimById.get(dimId);
      // Only manage ?mode/?value once the fold has landed in perTabMode —
      // the fold's ref flips one commit before its setState applies, and
      // falling back to readStoredMode in that gap wrote a stale mode.
      const mode = perTabMode[dimId];
      if (dim && mode !== undefined) {
        if (mode !== "records") next.set("mode", mode);
        else next.delete("mode");
        if (mode !== "match") next.delete("value");
        if (mode !== "match") next.delete("target");
      }
    } else {
      next.delete("active");
    }
    if (next.toString() !== window.location.search.replace(/^\?/, "")) {
      setSearchParams(next, { replace: true });
    }
  }, [tabs, activeTabId, perTabMode, dimById, setSearchParams]);

  if (dims.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
        <NoTablesYet from="tables" onCreateRequested={canEdit ? create.open : undefined} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TableTabStrip onCreateRequested={canEdit ? create.open : undefined} />

      <div className="relative flex-1 min-h-0">
        {tabs.map((tab) => {
          const dim = dimById.get(tab.dimId);
          if (!dim) return null;
          const isActive = tab.id === activeTabId;
          const modes = availableModes(dim, sources);
          const mode: Mode = perTabMode[tab.dimId] ?? readStoredMode(tab.dimId, modes);
          return (
            <div key={tab.id} hidden={!isActive} className="absolute inset-0 flex flex-col min-h-0">
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
          <div className="grid place-items-center px-8 py-16">
            <div className="text-center">
              <div className="font-display text-[20px] text-ink-2">No table open</div>
              <p className="mx-auto mt-2 max-w-[44ch] text-[12.5px] text-ink-3">
                Pick one from the sidebar, or press{" "}
                <kbd className="inline-flex items-center rounded-sm border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
                  ⌘K
                </kbd>{" "}
                to search.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
