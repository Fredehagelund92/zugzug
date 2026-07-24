import { useRef } from "react";
import type { FieldDef, MappingRefTable } from "../data";

export interface LinkedCandidate {
  key: string;
  label: string;
}
export interface LinkedTarget {
  candidates: LinkedCandidate[];
  /** label lookups for `↳` columns: targetField id → display label */
  fieldLabels: Map<string, string>;
}

/** Resolve linked-field picker candidates with identity-stable output.
 *  The store replaces only mutated refTable objects (refTables.map), so comparing the
 *  referenced refTables by object identity tells us whether anything this hook
 *  depends on actually changed — a plain useMemo on [allDims] re-fires on
 *  EVERY store emit because the array identity always changes. */
export function useLinkedCandidates(
  fields: FieldDef[],
  allDims: MappingRefTable[],
): Map<string, LinkedTarget> {
  const prev = useRef<{
    refs: Array<MappingRefTable | undefined>;
    out: Map<string, LinkedTarget>;
  } | null>(null);

  const referencedIds = fields
    .filter((f) => f.type === "linked" && f.referencedRefTableId)
    .map((f) => f.referencedRefTableId!);
  const refs = referencedIds.map((id) => allDims.find((d) => d.id === id));

  const p = prev.current;
  const unchanged =
    p !== null && p.refs.length === refs.length && p.refs.every((d, i) => d === refs[i]);
  if (unchanged) return p.out;

  const out = new Map<string, LinkedTarget>();
  referencedIds.forEach((id, i) => {
    const refTable = refs[i];
    if (!refTable || out.has(id)) return;
    out.set(id, {
      candidates: refTable.record.map((c) => ({ key: c.key, label: c.label })),
      fieldLabels: new Map((refTable.fields ?? []).map((f) => [f.field, f.label])),
    });
  });
  prev.current = { refs, out };
  return out;
}
