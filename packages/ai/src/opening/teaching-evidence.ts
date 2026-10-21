/**
 * V2-06 teaching evidence pack — assemble authorized chunks + coverage + claim support.
 * Reuses selectContext / renderContext (Package C). Does not replace soft resolveCitations.
 * No mastery / confidence %. No forged sources when materials are empty.
 */
import type { SourceChunk } from "@aistudy/contracts";
import {
  anchorKey,
  buildCoverageTable,
  lexicalOverlapScore,
  type ClaimEvidenceKind,
  type CoverageCondition,
  type CoverageRow,
  type SourceAnchor,
} from "@aistudy/domain";
import { renderContext, selectContext } from "./context";
import { budgetRankedMaterial } from "./hybrid-retrieval";

export type TeachingEvidenceDenylist = {
  problemIds?: readonly string[];
  paths?: readonly string[];
  sourceIds?: readonly string[];
};

export type TeachingEvidencePack = {
  chunks: SourceChunk[];
  anchors: SourceAnchor[];
  coverage: CoverageRow[];
  boundaries: {
    heldOutExcluded: boolean;
    privacyExcludedSourceIds: string[];
    noMaterials: boolean;
    externalSearch: "unavailable" | "not_used";
  };
};

export type AssembleTeachingEvidencePackInput = {
  /** Shared retrieval already ranked these chunks; preserve its semantic order. */
  ranked?: boolean;
  chunks: SourceChunk[];
  query: string;
  maxCharacters: number;
  preferChunkId?: string;
  preferPage?: number;
  allowlistSourceIds?: readonly string[];
  denylist?: TeachingEvidenceDenylist;
  privacyExcludedSourceIds?: readonly string[];
  conditions?: CoverageCondition[];
  /** Forced conflict condition ids passed through to buildCoverageTable. */
  conflicts?: readonly string[];
  externalSearch?: "unavailable" | "not_used";
};

function chunkToAnchor(chunk: SourceChunk): SourceAnchor {
  return {
    sourceId: chunk.sourceId,
    sourceVersion: chunk.sourceVersion,
    chunkId: chunk.id,
    page: chunk.page,
    slideLabel: chunk.slideLabel ?? null,
    startMs: chunk.startMs,
  };
}

function denylistWasUsed(denylist: TeachingEvidenceDenylist | undefined): boolean {
  if (!denylist) return false;
  return (
    (denylist.sourceIds?.length ?? 0) > 0 ||
    (denylist.paths?.length ?? 0) > 0 ||
    (denylist.problemIds?.length ?? 0) > 0
  );
}

/**
 * Throw if pack source ids intersect denylist.sourceIds, or if contextBlob
 * contains any denied path or problemId substring.
 */
export function assertNoHeldOutLeak(input: {
  packSourceIds: readonly string[];
  packChunkIds?: readonly string[];
  denylist: TeachingEvidenceDenylist;
  contextBlob?: string;
}): void {
  const deniedSources = new Set(input.denylist.sourceIds ?? []);
  for (const id of input.packSourceIds) {
    if (deniedSources.has(id)) {
      throw new Error(`held-out leak: sourceId ${id} is on denylist`);
    }
  }
  const blob = input.contextBlob ?? "";
  for (const path of input.denylist.paths ?? []) {
    if (path.length > 0 && blob.includes(path)) {
      throw new Error(`held-out leak: denied path appears in context: ${path}`);
    }
  }
  for (const problemId of input.denylist.problemIds ?? []) {
    if (problemId.length > 0 && blob.includes(problemId)) {
      throw new Error(`held-out leak: denied problemId appears in context: ${problemId}`);
    }
  }
  // Optional: problemIds must not appear as pack chunk ids either.
  for (const chunkId of input.packChunkIds ?? []) {
    for (const problemId of input.denylist.problemIds ?? []) {
      if (problemId.length > 0 && chunkId.includes(problemId)) {
        throw new Error(`held-out leak: denied problemId in chunkId: ${problemId}`);
      }
    }
  }
}

/** MUST reuse renderContext delimiters (UNTRUSTED DATA). */
export function formatProviderContext(chunks: SourceChunk[]): string {
  return renderContext(chunks);
}

export function assembleTeachingEvidencePack(
  input: AssembleTeachingEvidencePackInput,
): TeachingEvidencePack {
  const privacyExcluded = [...(input.privacyExcludedSourceIds ?? [])];
  const privacySet = new Set(privacyExcluded);
  let filtered = input.chunks.filter((c) => !privacySet.has(c.sourceId));

  if (input.allowlistSourceIds && input.allowlistSourceIds.length > 0) {
    const allow = new Set(input.allowlistSourceIds);
    filtered = filtered.filter((c) => allow.has(c.sourceId));
  }

  const deniedSourceIds = input.denylist?.sourceIds ?? [];
  if (deniedSourceIds.length > 0) {
    const denied = new Set(deniedSourceIds);
    filtered = filtered.filter((c) => !denied.has(c.sourceId));
  }

  assertNoHeldOutLeak({
    packSourceIds: filtered.map((c) => c.sourceId),
    packChunkIds: filtered.map((c) => c.id),
    denylist: input.denylist ?? {},
  });

  const selected = input.ranked ? budgetRankedMaterial(filtered, input.maxCharacters) : selectContext({
    chunks: filtered,
    query: input.query,
    maxCharacters: input.maxCharacters,
    preferChunkId: input.preferChunkId,
    preferPage: input.preferPage,
  });

  const contextBlob = renderContext(selected);
  assertNoHeldOutLeak({
    packSourceIds: selected.map((c) => c.sourceId),
    packChunkIds: selected.map((c) => c.id),
    denylist: input.denylist ?? {},
    contextBlob,
  });

  const anchors = selected.map(chunkToAnchor);
  const chunkTexts = new Map<string, string>();
  for (const chunk of selected) {
    chunkTexts.set(anchorKey(chunkToAnchor(chunk)), chunk.text);
  }

  const coverage =
    input.conditions && input.conditions.length > 0
      ? buildCoverageTable({
          conditions: input.conditions,
          anchors,
          chunkTexts,
          conflicts: input.conflicts,
        })
      : [];

  const noMaterials =
    filtered.length === 0 || (input.chunks.length === 0 && selected.length === 0);

  return {
    chunks: selected,
    anchors,
    coverage,
    boundaries: {
      heldOutExcluded: denylistWasUsed(input.denylist),
      privacyExcludedSourceIds: privacyExcluded,
      noMaterials,
      externalSearch: input.externalSearch ?? "not_used",
    },
  };
}

const HONOR_WITHOUT_MATERIAL: ReadonlySet<ClaimEvidenceKind> = new Set([
  "generated_example",
  "supplemental",
  "inference",
]);

/**
 * Find candidate material links, not proof of truth or entailment. Even complete
 * lexical overlap can repeat an incorrect source or reverse its meaning.
 * Citation id alone (no text overlap) is never material_reorg (AN-RN-06).
 */
export function classifyClaimSupport(input: {
  claimText: string;
  citedChunkIds: string[];
  pack: TeachingEvidencePack;
  expectedKind?: ClaimEvidenceKind;
}): {
  kind: ClaimEvidenceKind;
  anchors: SourceAnchor[];
  okForMaterialClaim: boolean;
  reason: string;
} {
  const byId = new Map(input.pack.chunks.map((c) => [c.id, c]));
  const citedInPack = input.citedChunkIds.filter((id) => byId.has(id));
  const unknownCited = input.citedChunkIds.filter((id) => !byId.has(id));
  const anchors = input.pack.anchors.filter((a) => citedInPack.includes(a.chunkId));

  let supportScore = 0;
  for (const id of citedInPack) {
    const chunk = byId.get(id)!;
    supportScore += lexicalOverlapScore(input.claimText, chunk.text);
  }

  const honorExpected = (): {
    kind: ClaimEvidenceKind;
    anchors: SourceAnchor[];
    okForMaterialClaim: boolean;
    reason: string;
  } | null => {
    if (input.expectedKind && HONOR_WITHOUT_MATERIAL.has(input.expectedKind)) {
      return {
        kind: input.expectedKind,
        anchors: [],
        okForMaterialClaim: false,
        reason: `no material support; honoring expectedKind=${input.expectedKind}`,
      };
    }
    return null;
  };

  if (input.citedChunkIds.length === 0) {
    const honored = honorExpected();
    if (honored) return honored;
    return {
      kind: "uncovered",
      anchors: [],
      okForMaterialClaim: false,
      reason: "no citations and no material_reorg without anchors",
    };
  }

  if (citedInPack.length === 0) {
    const honored = honorExpected();
    if (honored) return honored;
    return {
      kind: "uncovered",
      anchors: [],
      okForMaterialClaim: false,
      reason: `cited chunk ids not in pack: ${unknownCited.join(",")}`,
    };
  }

  if (supportScore > 0) {
    return {
      kind: "material_reorg",
      anchors,
      okForMaterialClaim: true,
      reason: "cited pack chunks have lexical overlap only; factual support is unverified",
    };
  }

  // Citation id alone without overlap → NOT material_reorg (AN-RN-06)
  const honored = honorExpected();
  if (honored) return honored;
  return {
    kind: "uncovered",
    anchors,
    okForMaterialClaim: false,
    reason: "citation id present without text support (AN-RN-06)",
  };
}
