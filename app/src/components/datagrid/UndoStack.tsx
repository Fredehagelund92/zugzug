import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* UndoStack — last-50, in-memory, per scope. Stacks live in a module-level
   map keyed by scopeKey so history survives provider unmounts (tab switches,
   route changes); a session reload clears everything. Not collaborative. */

export interface UndoEntry {
  apply: () => Promise<void>;
  inverse: () => Promise<void>;
  label: string;
  /** Optional surface tag — e.g. "Records", "Match" — shown next to the undo
   *  label so a user pressing ⌘Z sees which surface the inverse will land on. */
  surface?: string;
}

interface Ctx {
  push: (e: UndoEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  /** label of the top of the undo stack — surfaced in the toolbar */
  topLabel: string | null;
  /** surface tag of the top of the undo stack — surfaced in the toolbar so a
   *  user pressing ⌘Z sees which surface the inverse will land on. */
  topSurface: string | null;
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

interface ScopeStacks {
  undo: UndoEntry[];
  redo: UndoEntry[];
}
const scopeStacks = new Map<string, ScopeStacks>();
function stacksFor(key: string): ScopeStacks {
  let s = scopeStacks.get(key);
  if (!s) {
    s = { undo: [], redo: [] };
    scopeStacks.set(key, s);
  }
  return s;
}

export function UndoStackProvider({
  children,
  scopeKey,
}: {
  children: ReactNode;
  scopeKey?: string;
}) {
  const key = scopeKey ?? "default";
  const undoStack = useRef<UndoEntry[]>(stacksFor(key).undo);
  const redoStack = useRef<UndoEntry[]>(stacksFor(key).redo);
  // Open compound-undo group. While set, push() entries land here instead of
  // the main stack; endTransaction() flushes them as one combined entry.
  // Per-mount on purpose: a transaction must not span an unmount.
  const txRef = useRef<{ label: string; entries: UndoEntry[] } | null>(null);
  const [version, setVersion] = useState(0); // bumped to re-render canUndo/canRedo flags
  const bump = () => setVersion((v) => v + 1);

  // Re-point at the right scope's stacks when the scope changes (history is
  // preserved per scope, never cleared — that's the point of the module map).
  useEffect(() => {
    undoStack.current = stacksFor(key).undo;
    redoStack.current = stacksFor(key).redo;
    txRef.current = null;
    bump();
  }, [key]);

  const push = useCallback((e: UndoEntry) => {
    if (txRef.current) {
      txRef.current.entries.push(e);
      return; // coalesced — no bump until endTransaction
    }
    undoStack.current.push(e);
    if (undoStack.current.length > LIMIT) undoStack.current.shift();
    redoStack.current.length = 0; // any new mutation invalidates the redo path
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
    const surfaces = new Set(tx.entries.map((e) => e.surface).filter((s): s is string => !!s));
    const surface = surfaces.size === 1 ? [...surfaces][0] : undefined;
    const combined: UndoEntry =
      tx.entries.length === 1
        ? { ...tx.entries[0], label: tx.label, surface }
        : {
            label: tx.label,
            surface,
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
    redoStack.current.length = 0;
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
    topSurface: undoStack.current.at(-1)?.surface ?? null,
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
