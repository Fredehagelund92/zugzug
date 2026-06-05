import type { MappingDimension } from "../data";
import type { SourceInfo } from "../store";

export type Mode = "records" | "match" | "sources";

export function availableModes(dim: MappingDimension, sources: SourceInfo[]): Mode[] {
  const hasSourceWiring = sources.some((s) => s.dimId === dim.id);
  return hasSourceWiring ? ["records", "match", "sources"] : ["records"];
}
