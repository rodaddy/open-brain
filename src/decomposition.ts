import type { Table } from "./types.ts";
import { CHUNK_THRESHOLD, chunkText } from "./chunking.ts";

export const DEFAULT_DECOMPOSITION_MAX_CHARS = 2000;
export const DEFAULT_DECOMPOSITION_OVERLAP_CHARS = 200;

export interface SourceRef {
  source: "brain";
  table: Table;
  id: string;
  namespace: string;
}

export interface ReplacementProposal {
  content: string;
  chunk_index: number;
  content_length: number;
  source_ref: SourceRef;
  links: Array<{
    relation: "supplements";
    target: SourceRef;
  }>;
  provenance: {
    source: "dreamengine-decomposition";
    source_table: Table;
    source_id: string;
    source_namespace: string;
    chunk_index: number;
  };
}

export interface DecompositionPlan {
  status: "not_oversized" | "planned";
  dry_run: true;
  oversized: boolean;
  source_ref: SourceRef;
  source_length: number;
  threshold: number;
  max_chunk_chars: number;
  overlap_chars: number;
  proposed_replacements: ReplacementProposal[];
  proposed_links: ReplacementProposal["links"];
  would_write: number;
  fetch_path: {
    tool: "get_entry";
    arguments: { table: Table; id: string; render: "full" };
  };
}

export function planEntryDecomposition(input: {
  table: Table;
  id: string;
  namespace: string;
  content: string;
  maxChunkChars?: number;
  overlapChars?: number;
  threshold?: number;
}): DecompositionPlan {
  const maxChunkChars =
    input.maxChunkChars ?? DEFAULT_DECOMPOSITION_MAX_CHARS;
  const overlapChars =
    input.overlapChars ?? DEFAULT_DECOMPOSITION_OVERLAP_CHARS;
  const threshold = input.threshold ?? CHUNK_THRESHOLD;
  const sourceRef: SourceRef = {
    source: "brain",
    table: input.table,
    id: input.id,
    namespace: input.namespace,
  };
  const sourceLength = input.content.length;
  const oversized = sourceLength > threshold;
  const chunks = oversized ? chunkText(input.content, maxChunkChars, overlapChars) : [];
  const proposedReplacements = chunks.map((chunk): ReplacementProposal => ({
    content: chunk.text,
    chunk_index: chunk.index,
    content_length: chunk.text.length,
    source_ref: sourceRef,
    links: [{ relation: "supplements", target: sourceRef }],
    provenance: {
      source: "dreamengine-decomposition",
      source_table: input.table,
      source_id: input.id,
      source_namespace: input.namespace,
      chunk_index: chunk.index,
    },
  }));

  return {
    status: oversized ? "planned" : "not_oversized",
    dry_run: true,
    oversized,
    source_ref: sourceRef,
    source_length: sourceLength,
    threshold,
    max_chunk_chars: maxChunkChars,
    overlap_chars: overlapChars,
    proposed_replacements: proposedReplacements,
    proposed_links: proposedReplacements.flatMap((proposal) => proposal.links),
    would_write: proposedReplacements.length,
    fetch_path: {
      tool: "get_entry",
      arguments: { table: input.table, id: input.id, render: "full" },
    },
  };
}
