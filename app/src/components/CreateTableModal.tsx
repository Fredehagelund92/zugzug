import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { IconX } from "./Icons";
import { PALETTE, PALETTE_NAMES, defaultTintFor } from "../lib/palette";
import { createTable, useSources, type CreateTableMode, type CreateTableInput } from "../store";
import { toast } from "./Toast";
import { ComboSelect } from "./ComboSelect";
import type { PaletteName } from "../data";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { prepareCreateFromCsv, type CreateFromCsv } from "../lib/csv";

const MODE_LABEL: Record<CreateTableMode, string> = {
  blank: "empty table",
  source: "from a column",
  file: "from a file",
  external_id: "from a lookup table",
};

interface Props {
  open: boolean;
  defaultMode?: CreateTableMode;
  onClose: () => void;
  onCreated: (id: string) => void;
}

/* CreateTableModal — Airtable-style one-page scaffold. Identity (monogram tint
   + description) lives at the top; a three-pill mode segment swaps the form
   below it (blank → column scaffold; source → 1 picker; from IDs → 2 pickers).
   Posts to /api/tables in one round-trip and consolidates the audit log entry. */

export function CreateTableModal({ open, defaultMode = "blank", onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<PaletteName>(() => defaultTintFor(String(Date.now())));
  const nav = useNavLinks();
  const [mode, setMode] = useState<CreateTableMode>(defaultMode);
  const [source, setSource] = useState<{ table: string; column: string } | null>(null);
  const [external, setExternal] = useState<{
    table: string;
    idColumn: string;
    nameColumn: string;
  } | null>(null);
  const [csv, setCsv] = useState<{ fileName: string; data: CreateFromCsv } | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const sources = useSources();
  const sourceOpts = useMemo(
    () => Array.from(new Set(sources.map((s) => `${s.table}.${s.column}`))).sort(),
    [sources],
  );
  const columnsOfTable = (table: string): string[] =>
    Array.from(new Set(sources.filter((s) => s.table === table).map((s) => s.column))).sort();

  // reset on open
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setMode(defaultMode);
    setColor(defaultTintFor(String(Date.now())));
    setSource(null);
    setExternal(null);
    setCsv(null);
    setCsvError(null);
    setConfirmingDiscard(false);
  }, [open, defaultMode]);

  const canSubmit = useMemo((): boolean => {
    if (!name.trim()) return false;
    if (mode === "source") return !!(source?.table && source?.column);
    if (mode === "external_id")
      return !!(external?.table && external?.idColumn && external?.nameColumn);
    if (mode === "file") return !!csv;
    return true; // blank: name is enough
  }, [name, mode, source, external, csv]);

  // Why "Create table" is disabled right now — shown next to the button so the
  // dead-disabled state explains itself instead of leaving the user guessing.
  const blockReason = useMemo((): string | null => {
    if (canSubmit) return null;
    if (!name.trim()) return "Name your table to continue";
    if (mode === "source") return "Pick a column to continue";
    if (mode === "external_id")
      return external?.idColumn ? "Pick a name column to continue" : "Pick an ID column to continue";
    if (mode === "file") return "Choose a CSV file to continue";
    return null;
  }, [canSubmit, name, mode, external]);

  // Read a chosen CSV, parse it client-side, and stage the result. Errors show
  // inline in the file panel rather than as a toast (the modal is still open).
  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      e.target.value = ""; // let the user re-pick the same file after an error
      if (!file) return;
      try {
        const data = prepareCreateFromCsv(await file.text());
        setCsv({ fileName: file.name, data });
        setCsvError(null);
        setName((n) => n.trim() || file.name.replace(/\.csv$/i, ""));
      } catch (err) {
        setCsv(null);
        setCsvError(err instanceof Error ? err.message : "Could not read this file.");
      }
    },
    [],
  );

  // Close request — checks dirty state and prompts to discard if so.
  // Considered "dirty" when the user has typed a name, picked a source, or
  // bound an external id. The optional description/colour aren't counted —
  // a casual mode flip shouldn't trigger a guard.
  const requestClose = useCallback((): void => {
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
      return;
    }
    const isDirty = name.trim().length > 0 || source !== null || external !== null || csv !== null;
    if (isDirty) setConfirmingDiscard(true);
    else onClose();
  }, [confirmingDiscard, name, source, external, csv, onClose]);

  const submit = useCallback((): void => {
    if (!canSubmit) return;

    const payload: CreateTableInput = {
      name: name.trim(),
      description: description.trim() || null,
      color,
      mode,
      ...(mode === "source" && source ? { source } : {}),
      ...(mode === "external_id" && external ? { external } : {}),
      ...(mode === "file" && csv
        ? { file: { columns: csv.data.columns, rows: csv.data.rows } }
        : {}),
    };

    // Close immediately — background provisioning continues after this.
    onClose();

    const run = (p: CreateTableInput): void => {
      void createTable(p).then(
        (id) => {
          onCreated(id);
        },
        (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          toast(`Failed to create "${p.name}": ${msg}`, "error", {
            label: "Retry",
            onClick: () => run(p),
          });
        },
      );
    };
    run(payload);
  }, [canSubmit, name, description, color, mode, source, external, csv, onCreated, onClose]);

  // Esc to close (or cancel the discard prompt if it's already showing)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmingDiscard) setConfirmingDiscard(false);
        else requestClose();
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) submit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, canSubmit, requestClose, submit, confirmingDiscard]);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const monogram = (name.trim().charAt(0) || "?").toUpperCase();
  const tint = PALETTE[color];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/50 p-4 backdrop-blur-sm md:p-6"
      onClick={requestClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-table-title"
        onClick={(e) => e.stopPropagation()}
        className="mt-[5vh] w-full rounded-lg border border-line-2 bg-surface-elevated shadow-pop md:mt-[10vh] md:w-[520px]"
      >
        {/* accent edge */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" />

        <div className="space-y-3 px-6 pb-5 pt-6">
          <div className="flex items-start justify-between">
            <div
              id="create-table-title"
              className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3"
            >
              New table
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="close"
              className="text-ink-3 hover:text-ink"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* identity */}
          <div className="flex items-center gap-3">
            <div
              className="grid h-8 w-8 shrink-0 place-items-center rounded-sm font-display text-[15px] font-bold text-white"
              style={{ background: tint.bg, boxShadow: `0 0 0 1.5px ${tint.border}` }}
            >
              {monogram}
            </div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name this table"
              className="w-full border-0 border-b border-line bg-transparent py-1.5 font-display text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
          </div>

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="describe what's in this table (optional)"
            aria-label="Description"
            className="w-full resize-none border-0 bg-transparent py-1 font-body text-[13px] text-ink-2 outline-none placeholder:text-ink-3"
          />

          {/* palette swatch row */}
          <div className="ml-0 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">
            <span>tint</span>
            {PALETTE_NAMES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                title={c}
                className={`h-3.5 w-3.5 rounded-sm transition-transform hover:scale-110 ${color === c ? "ring-1 ring-ink" : ""}`}
                style={{ background: PALETTE[c].bg }}
              />
            ))}
          </div>
        </div>

        {/* mode segment */}
        <div className="space-y-2 px-6 pb-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
            Start from
          </div>
          <div
            role="group"
            aria-label="Start from"
            className="flex flex-wrap gap-0.5 rounded-sm border border-line bg-bg p-0.5"
          >
            {(["blank", "source", "file", "external_id"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`min-w-0 flex-1 rounded-sm px-2 py-1.5 font-body text-[11.5px] leading-tight transition-colors md:px-2.5 md:text-[12.5px] ${mode === m ? "border border-line-2 bg-surface-3 text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>

        {/* errors surface as toasts after the modal closes (optimistic submit) */}

        {/* swappable region */}
        <div className="px-6 pb-4 pt-2">
          {/* ─── blank: just the intent + a note. Fields are added later from
              the table view via AddFieldPopover, which already handles the type
              picker + per-type options. Deferring keeps this modal focused on
              the irreversible decisions (name + key kind). ─────────────────── */}
          {mode === "blank" && (
            <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
              <p className="font-body text-[12.5px] leading-[1.5] text-ink-2">
                Start with an empty list. Name each record; a permanent key is created from the name
                automatically.
              </p>
              <p className="font-mono text-[11px] leading-[1.5] text-ink-3">
                You can add extra columns (region, currency, owner…) from the table view later —
                nothing is locked in here.
              </p>
            </div>
          )}

          {/* ─── source: 1 picker ───────────────────────────────────────────────── */}
          {mode === "source" &&
            (() => {
              const info = source
                ? sources.find((s) => s.table === source.table && s.column === source.column)
                : null;
              const helper = !source
                ? "Distinct values from the chosen column become records. Already-mapped values are skipped."
                : !info
                  ? "Distinct values from the chosen column become records. Already-mapped values are skipped."
                  : !info.scanned
                    ? "Scan pending — count will appear after the first scan."
                    : info.values === 0
                      ? "No values found in this column yet. You can still create the table — it fills in as data arrives."
                      : `${info.values.toLocaleString()} distinct value${info.values === 1 ? "" : "s"} found — each becomes one record. Already-mapped values are skipped.`;
              return (
                <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
                  <p className="font-body text-[12.5px] leading-[1.5] text-ink-2">
                    Seed records from a warehouse column. Example: a country column with ‘USA’,
                    ‘Canada’ and ‘United States’ becomes records usa, canada and united_states — you
                    can merge and rename them afterwards.
                  </p>
                  {sourceOpts.length === 0 ? (
                    <div className="font-mono text-[11px] leading-[1.5] text-ink-3">
                      No warehouse columns available yet. An admin connects a database under
                      Settings → Warehouse; then you pick columns on the{" "}
                      <a href={nav.sources} className="text-accent underline">
                        Sources
                      </a>{" "}
                      page.
                      <br />
                      Until then, start with a blank table — you can add a source later.
                    </div>
                  ) : (
                    <>
                      <ComboSelect
                        options={sourceOpts}
                        value={source ? `${source.table}.${source.column}` : null}
                        placeholder="pick a warehouse column…"
                        onPick={(opt) => {
                          const dot = opt.lastIndexOf(".");
                          if (dot > 0)
                            setSource({ table: opt.slice(0, dot), column: opt.slice(dot + 1) });
                        }}
                      />
                      <div className="font-mono text-[11px] leading-[1.5] text-ink-3">{helper}</div>
                    </>
                  )}
                </div>
              );
            })()}

          {/* ─── file: upload a CSV; headers become text fields, rows records ───── */}
          {mode === "file" && (
            <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
              <p className="font-body text-[12.5px] leading-[1.5] text-ink-2">
                Upload a CSV. The first column (or one named “name”) names each record; every other
                column becomes a text field you can retype later.
              </p>
              {!csv ? (
                <>
                  <label className="flex cursor-pointer items-center justify-center rounded-sm border border-dashed border-line-2 bg-bg px-3 py-4 font-body text-[12.5px] text-ink-2 hover:border-accent hover:text-ink">
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={handleFile}
                    />
                    Choose a CSV file
                  </label>
                  {csvError && (
                    <div className="rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-1.5 font-mono text-[11px] leading-[1.5] text-danger">
                      {csvError}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px] text-ink">{csv.fileName}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setCsv(null);
                        setCsvError(null);
                      }}
                      className="shrink-0 font-mono text-[11px] text-ink-3 hover:text-ink"
                    >
                      change
                    </button>
                  </div>
                  <div className="font-mono text-[11px] leading-[1.5] text-ink-3">
                    {csv.data.recordCount.toLocaleString()} record
                    {csv.data.recordCount === 1 ? "" : "s"} · name ← “{csv.data.nameHeader}” ·{" "}
                    {csv.data.columns.length} field{csv.data.columns.length === 1 ? "" : "s"}
                  </div>
                  <div className="max-h-32 overflow-auto rounded-sm border border-line">
                    <table className="w-full border-collapse font-mono text-[10.5px]">
                      <thead>
                        <tr className="bg-bg text-ink-3">
                          {csv.data.headers.map((h, i) => (
                            <th key={i} className="border-b border-line px-2 py-1 text-left font-medium">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csv.data.previewRows.map((r, ri) => (
                          <tr key={ri} className="text-ink-2">
                            {csv.data.headers.map((_, ci) => (
                              <td key={ci} className="border-b border-line px-2 py-1 whitespace-nowrap">
                                {r[ci] ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── external_id: 2 pickers ─────────────────────────────────────────── */}
          {mode === "external_id" && (
            <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
              <p className="font-body text-[12.5px] leading-[1.5] text-ink-2">
                For lookup tables. The warehouse ID becomes the permanent key; a second column
                provides the human name shown alongside it.
              </p>
              <div className="rounded-sm border border-warn/30 bg-warn-soft px-2.5 py-1.5 font-mono text-[11px] leading-[1.5] text-warn">
                {external?.idColumn ? (
                  <>
                    ⚠ <span className="text-ink">
                      {external.table}.{external.idColumn}
                    </span>{" "}
                    becomes the permanent key — it can&rsquo;t be changed later. Pick a column that
                    never changes, like a database ID, not a name.
                  </>
                ) : (
                  <>
                    ⚠ The ID column is permanent — it becomes the key other tables map to. Pick a
                    column that never changes, like a database ID, not a name.
                  </>
                )}
              </div>
              {sourceOpts.length === 0 ? (
                <div className="font-mono text-[11px] leading-[1.5] text-ink-3">
                  No warehouse columns available yet. An admin connects a database under Settings →
                  Warehouse; then you pick columns on the{" "}
                  <a href={nav.sources} className="text-accent underline">
                    Sources
                  </a>{" "}
                  page.
                  <br />
                  Until then, start with a blank table — you can add a source later.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <div>
                      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">
                        id column
                      </div>
                      <ComboSelect
                        options={sourceOpts}
                        value={external ? `${external.table}.${external.idColumn}` : null}
                        placeholder="pick the id column…"
                        onPick={(opt) => {
                          const dot = opt.lastIndexOf(".");
                          if (dot > 0) {
                            const table = opt.slice(0, dot);
                            const idColumn = opt.slice(dot + 1);
                            setExternal((prev) => ({
                              table,
                              idColumn,
                              nameColumn: prev && prev.table === table ? prev.nameColumn : "",
                            }));
                          }
                        }}
                      />
                    </div>
                    <div>
                      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">
                        name column
                      </div>
                      <ComboSelect
                        options={
                          external?.table
                            ? columnsOfTable(external.table).filter((c) => c !== external.idColumn)
                            : []
                        }
                        value={external?.nameColumn || null}
                        placeholder={
                          external?.table ? "pick the name column…" : "pick an id column first"
                        }
                        disabled={!external?.table}
                        onPick={(opt) =>
                          setExternal((prev) => (prev ? { ...prev, nameColumn: opt } : prev))
                        }
                      />
                    </div>
                  </div>
                  {(() => {
                    if (!external?.table || !external?.idColumn) return null;
                    const info = sources.find(
                      (s) => s.table === external.table && s.column === external.idColumn,
                    );
                    if (!info) return null;
                    if (!info.scanned)
                      return (
                        <div className="font-mono text-[11px] leading-[1.5] text-ink-3">
                          Scan pending — the uniqueness check appears after the first scan.
                        </div>
                      );
                    if (info.rows === 0)
                      return (
                        <div className="font-mono text-[11px] leading-[1.5] text-ink-3">
                          No values found in this column yet. You can still create the table — it
                          fills in as data arrives.
                        </div>
                      );
                    // A good permanent key has one row per value. If distinct &lt; total, some IDs
                    // repeat and the column can't safely be the join key.
                    return info.values >= info.rows ? (
                      <div className="font-mono text-[11px] leading-[1.5] text-ok">
                        {info.values.toLocaleString()} / {info.rows.toLocaleString()} unique — every
                        value appears once. A reliable key.
                      </div>
                    ) : (
                      <div className="font-mono text-[11px] leading-[1.5] text-warn">
                        Only {info.values.toLocaleString()} of {info.rows.toLocaleString()} values are
                        unique — some repeat. This column won&rsquo;t work as a permanent key; pick one
                        with no duplicates.
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}
        </div>

        {/* footer — swaps to a discard prompt if the user tries to close with
            in-progress work, so backdrop / ESC / X / Cancel don't silently drop
            it */}
        <div className="flex items-center justify-between gap-2 rounded-b-lg border-t border-line bg-bg/40 px-6 py-3">
          {confirmingDiscard ? (
            <>
              <span className="font-mono text-[12px] text-ink-2">Discard this table?</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDiscard(false)}>
                  Keep editing
                </Button>
                <Button size="sm" onClick={onClose}>
                  Discard
                </Button>
              </div>
            </>
          ) : (
            <>
              <span className="font-mono text-[11px] text-ink-3">{blockReason}</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={requestClose}>
                  Cancel
                </Button>
                <Button size="sm" onClick={submit} disabled={!canSubmit}>
                  Create table
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
