import { Link } from "react-router-dom";
import { Button } from "./Button";
import { IconArrowRight, IconPlus } from "./Icons";
import { useNavLinks } from "../lib/use-tenant-navigate";

/* NoTablesYet — shared empty-state for the value-mapping + master-list
   routes when the workspace has zero tables. Replaces a crash that
   used to happen because Mapping/MasterTables indexed dims[0] directly. */
export function NoTablesYet({
  from,
  onCreateRequested,
}: {
  from: "mapping" | "tables" | "triage";
  /** When provided, surfaces a primary "Create blank table" button that
   *  opens CreateTableModal directly. The Sources flow becomes secondary. */
  onCreateRequested?: () => void;
}) {
  const nav = useNavLinks();
  return (
    <div className="zz-rise mx-auto max-w-xl rounded-lg border border-line bg-surface p-10 text-center">
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
        No tables yet
      </div>
      <h1 className="mt-2 font-display text-[clamp(22px,3vw,32px)] font-extrabold leading-tight tracking-[-0.03em] text-ink">
        Nothing to {from === "mapping" ? "map" : from === "triage" ? "review" : "manage"} yet.
      </h1>
      <p className="mt-3 text-ink-2">
        Create a table from scratch, or import one from a warehouse column.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {onCreateRequested ? (
          <Button icon={<IconPlus className="h-4 w-4" />} onClick={onCreateRequested}>
            Create blank table
          </Button>
        ) : (
          <Button disabled icon={<IconPlus className="h-4 w-4" />} title="Viewers can't create tables">
            Create blank table
          </Button>
        )}
        <Link to={nav.sources}>
          <Button
            variant={onCreateRequested ? "secondary" : undefined}
            icon={<IconArrowRight className="h-4 w-4" />}
          >
            Wire a source
          </Button>
        </Link>
      </div>
      {!onCreateRequested && (
        <p className="mt-2 text-[12px] text-ink-3">
          You have view-only access. Ask a workspace admin to make you an editor
          (Settings → Members) to create tables.
        </p>
      )}
    </div>
  );
}
