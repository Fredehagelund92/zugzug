import { Link } from "react-router-dom";
import { Button } from "./Button";
import { IconArrowRight } from "./Icons";

/* NoTablesYet — shared empty-state for the value-mapping + master-list
   routes when the workspace has zero tables. Replaces a crash that
   used to happen because Mapping/MasterTables indexed dims[0] directly. */
export function NoTablesYet({ from }: { from: "mapping" | "tables" }) {
  return (
    <div className="zz-rise mx-auto max-w-xl rounded-lg border border-line bg-surface p-10 text-center">
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">No tables yet</div>
      <h1 className="mt-2 font-display text-[clamp(22px,3vw,32px)] font-extrabold leading-tight tracking-[-0.03em] text-ink">
        Nothing to {from === "mapping" ? "match" : "manage"} yet.
      </h1>
      <p className="mt-3 text-ink-2">
        Create a table from scratch, or import one from a warehouse column.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Link to="/app/sources">
          <Button icon={<IconArrowRight className="h-4 w-4" />}>Wire a source</Button>
        </Link>
      </div>
    </div>
  );
}
