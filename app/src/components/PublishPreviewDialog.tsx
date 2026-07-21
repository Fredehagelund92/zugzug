import type { Draft } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconArrowRight } from "./Icons";

export interface PublishGroup {
  dimId: string;
  dimName: string;
  nextVersion: number;
  drafts: Draft[];
  changedKeys: string[];
}

const SAMPLE = 50;

/** Pre-publish review: exactly what ships in each table's next version.
 *  Staged mappings are reversible until confirm; record edits are already in
 *  the working copy and listed for awareness only. */
export function PublishPreviewDialog({
  open,
  groups,
  publishing,
  onDiscardDraft,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  groups: PublishGroup[];
  publishing: boolean;
  onDiscardDraft?: (d: Draft) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const totalDrafts = groups.reduce((n, g) => n + g.drafts.length, 0);
  const totalEdits = groups.reduce((n, g) => n + g.changedKeys.length, 0);
  const title =
    groups.length === 1
      ? `Publish v${groups[0].nextVersion} of ${groups[0].dimName}?`
      : `Publish ${groups.length} tables?`;

  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={publishing ? "Publishing…" : "Publish"}
      loading={publishing}
      onConfirm={onConfirm}
      onCancel={onCancel}
      body={
        <div className="max-h-80 space-y-3 overflow-y-auto text-left">
          {groups.map((g) => (
            <div key={g.dimId} className="rounded-sm border border-line bg-surface-2 p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                {g.dimName} → v{g.nextVersion}
              </div>
              {g.drafts.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {g.drafts.slice(0, SAMPLE).map((d) => (
                    <li
                      key={`${d.dimId}::${d.raw}`}
                      className="flex items-center gap-2 font-mono text-[11px] text-ink-2"
                    >
                      <span className="truncate">{d.raw}</span>
                      <IconArrowRight className="h-3 w-3 shrink-0 text-ink-3" />
                      <span className="truncate text-accent">{d.targetLabel ?? "—"}</span>
                      <span className="ml-auto shrink-0 text-ink-3">
                        {d.source === "ai" ? `AI · ${d.confidence ?? "?"}` : d.user.name}
                      </span>
                      {onDiscardDraft && (
                        <button
                          type="button"
                          aria-label={`Don't publish mapping for ${d.raw}`}
                          onClick={() => onDiscardDraft(d)}
                          className="shrink-0 text-ink-3 hover:text-danger"
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                  {g.drafts.length > SAMPLE && (
                    <li className="font-mono text-[11px] text-ink-3">
                      … and {g.drafts.length - SAMPLE} more
                    </li>
                  )}
                </ul>
              )}
              {g.changedKeys.length > 0 && (
                <div className="mt-1.5 font-mono text-[11px] text-ink-3">
                  + {g.changedKeys.length} record edit{g.changedKeys.length === 1 ? "" : "s"}{" "}
                  already in the working copy ({g.changedKeys.slice(0, 8).join(", ")}
                  {g.changedKeys.length > 8 ? ", …" : ""})
                </div>
              )}
            </div>
          ))}
          <p className="text-[12px] text-ink-3">
            Publishing creates {totalDrafts + totalEdits === 1 ? "a new version" : "new versions"}{" "}
            that dbt consumers pick up immediately. Draft mappings can still be removed here; record
            edits are listed for awareness.
          </p>
        </div>
      }
    />
  );
}
