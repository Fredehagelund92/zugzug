import type { MappingRefTable } from "../data";
import type { SourceInfo } from "../store";

export type Mode = "records" | "match" | "sources";

export function availableModes(refTable: MappingRefTable, sources: SourceInfo[]): Mode[] {
  const hasSourceWiring = sources.some((s) => s.refTableId === refTable.id);
  return hasSourceWiring ? ["records", "match", "sources"] : ["records"];
}
