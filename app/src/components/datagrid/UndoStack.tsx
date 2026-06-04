import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
  /** Begin a compound undo group. Every push() between begin/end is coalesced
   *  into a single entry labelled `label`. Async-safe (the group is open until
   *  endTransaction is called, not until the JS frame ends). Nested calls are
   *  ignored — only the outermost begin/end pair has effect. */
  beginTransaction: (label: string) => void;
  /** Close the current transaction and push the coalesced entry. No-op if no
   *  transaction is open or if it captured zero pushes. */
  endTransaction: () => void;
}

const UndoCtx = createContext<Ctx | null>(null);

const LIMIT = 50;

export function UndoStackProvider({
  children,
  scopeKey,
}: {
  children: ReactNode;
  scopeKey?: string;
}) {
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  // Open compound-undo group. While set, push() entries land here instead of
  // the main stack; endTransaction() flushes them as one combined entry.
  const txRef = useRef<{ label: string; entries: UndoEntry[] } | null>(null);
  const [version, setVersion] = useState(0); // bumped to re-render canUndo/canRedo flags
  const bump = () => setVersion((v) => v + 1);

  // clear both stacks when the scope (dimension id) changes
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    txRef.current = null;
    bump();
  }, [scopeKey]);

  const push = useCallback((e: UndoEntry) => {
    if (txRef.current) {
      txRef.current.entries.push(e);
      return; // coalesced — no bump until endTransaction
    }
    undoStack.current.push(e);
    if (undoStack.current.length > LIMIT) undoStack.current.shift();
    redoStack.current = []; // any new mutation invalidates the redo path
    bump();
  }, []);

  const beginTransaction = useCallback((label: string) => {
    if (txRef.current) return; // ignore nesting — outer wins
    txRef.current = { label, entries: [] };
  }, []);

  const endTransaction = useCallback(() => {
    const tx = txRef.current;
    if (!tx) return;
    txRef.current = null;
    if (tx.entries.length === 0) return;
    const combined: UndoEntry =
      tx.entries.length === 1
        ? { ...tx.entries[0], label: tx.label }
        : {
            label: tx.label,
            apply: async () => {
              for (const e of tx.entries) await e.apply();
            },
            // Inverses run in reverse order so each undo step sees the state its
            // forward step produced — same invariant as a stack of single edits.
            inverse: async () => {
              for (let i = tx.entries.length - 1; i >= 0; i--) await tx.entries[i].inverse();
            },
          };
    undoStack.current.push(combined);
    if (undoStack.current.length > LIMIT) undoStack.current.shift();
    redoStack.current = [];
    bump();
  }, []);

  // Peek-then-pop: keep the entry on the stack until the inverse succeeds so a
  // failed network round-trip leaves the user with an undo they can retry,
  // rather than silently consuming the entry and stranding the UI.
  const undo = useCallback(async () => {
    const e = undoStack.current.at(-1);
    if (!e) return;
    try {
      await e.inverse();
      undoStack.current.pop();
      redoStack.current.push(e);
    } catch (err) {
      console.error("undo inverse failed:", err);
    }
    bump();
  }, []);

  const redo = useCallback(async () => {
    const e = redoStack.current.at(-1);
    if (!e) return;
    try {
      await e.apply();
      redoStack.current.pop();
      undoStack.current.push(e);
    } catch (err) {
      console.error("redo apply failed:", err);
    }
    bump();
  }, []);

  const value: Ctx = {
    push,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    topLabel: undoStack.current.at(-1)?.label ?? null,
    beginTransaction,
    endTransaction,
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
