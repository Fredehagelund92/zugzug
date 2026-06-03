import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/* UndoStack — last-50, in-memory, per-mount. Cleared on route change or
   dimension switch (the consumer remounts the provider when the active
   dimension changes). Not collaborative; not persisted. */

export interface UndoEntry {
  apply: () => Promise<void>;
  inverse: () => Promise<void>;
  label: string;
}

interface Ctx {
  push: (e: UndoEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  /** label of the top of the undo stack — surfaced in the toolbar */
  topLabel: string | null;
}

const UndoCtx = createContext<Ctx | null>(null);

const LIMIT = 50;

export function UndoStackProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string }) {
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const [version, setVersion] = useState(0);   // bumped to re-render canUndo/canRedo flags
  const bump = () => setVersion((v) => v + 1);

  // clear both stacks when the scope (dimension id) changes
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    bump();
  }, [scopeKey]);

  const push = useCallback((e: UndoEntry) => {
    undoStack.current.push(e);
    if (undoStack.current.length > LIMIT) undoStack.current.shift();
    redoStack.current = []; // any new mutation invalidates the redo path
    bump();
  }, []);

  const undo = useCallback(async () => {
    const e = undoStack.current.pop();
    if (!e) return;
    try { await e.inverse(); redoStack.current.push(e); }
    catch (err) { console.warn("undo inverse failed:", err); /* silently no-op */ }
    bump();
  }, []);

  const redo = useCallback(async () => {
    const e = redoStack.current.pop();
    if (!e) return;
    try { await e.apply(); undoStack.current.push(e); }
    catch (err) { console.warn("redo apply failed:", err); }
    bump();
  }, []);

  const value: Ctx = {
    push, undo, redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    topLabel: undoStack.current.at(-1)?.label ?? null,
  };
  // version is read in deps below to keep value identity in sync
  void version;
  return <UndoCtx.Provider value={value}>{children}</UndoCtx.Provider>;
}

export function useUndoStack(): Ctx {
  const c = useContext(UndoCtx);
  if (!c) throw new Error("useUndoStack outside <UndoStackProvider>");
  return c;
}
