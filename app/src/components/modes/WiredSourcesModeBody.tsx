import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../Button";
import { IconArrowRight } from "../Icons";
import { LedgerRow } from "../sources/LedgerRow";
import { deriveCanonical, setSourceSchedule, useSources } from "../../store";
import type { MappingDimension } from "../../data";

/* WiredSourcesModeBody — third mode for a per-table workbench tab. Strips the
   schema accordion, Standing callout, and Browse warehouse chrome from
   Sources (only one table is in scope here); keeps the LedgerRow,
   ScanScheduleMenu, derive button, status chip, and expandable unmapped
   sample. A reverse-handoff button up top deep-links into the full Sources
   ledger, focused on this dim's first wired schema. */

interface Props {
  dim: MappingDimension;
}

export function WiredSourcesModeBody({ dim }: Props) {
  const sources = useSources();
  const [expanded, setExpanded] = useState<string | null>(null);
  const wired = useMemo(() => sources.filter((s) => s.dimId === dim.id), [sources, dim.id]);

  if (wired.length === 0) {
    return (
      <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
        nothing wired to this table yet
      </div>
    );
  }

  // The reverse handoff target: the schema of the first wired column.
  const firstSchema = wired[0].table.split(".")[0];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Link to={`/app/sources?focus=${encodeURIComponent(firstSchema)}`}>
          <Button variant="ghost" size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
            View in Sources
          </Button>
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto">
        {wired.map((row) => {
          const key = `${row.dimId}::${row.table}::${row.column}`;
          return (
            <LedgerRow
              key={key}
              row={row}
              expanded={expanded === key}
              onToggle={() => setExpanded(expanded === key ? null : key)}
              onScheduleChange={(next) =>
                void setSourceSchedule(row.dimId, row.table, row.column, next)
              }
              onDerive={() => void deriveCanonical(row.dimId, row.table, row.column)}
            />
          );
        })}
      </div>
    </div>
  );
}
