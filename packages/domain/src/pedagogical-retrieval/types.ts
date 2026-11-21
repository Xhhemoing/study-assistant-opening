/**
 * Closed-Core types for AIstudy v3.0 Structure-Preserving Pedagogical Retrieval.
 * Pure browser-safe TypeScript — zero Node.js, database, or AI SDK imports.
 */

export type PedagogicalVisibility = "public" | "hint_gated" | "sealed";

export type PedagogicalBlockKind =
  | "prose"
  | "heading"
  | "display_math"
  | "theorem"
  | "lemma"
  | "proof"
  | "definition"
  | "example"
  | "exercise"
  | "solution"
  | "hint"
  | "code"
  | "table"
  | "transcript_cue";

export interface PageSpan {
  readonly page: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface PedagogicalAstBlock {
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly atomicConstruct: boolean;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly keyframeChunkId: string | null;
  readonly label?: string;
}

export interface PedagogicalChunk {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly privacyEpoch?: number;
  readonly kind: PedagogicalBlockKind;
  readonly constructKinds: readonly PedagogicalBlockKind[];
  readonly visibility: PedagogicalVisibility;
  readonly atomicConstruct: boolean;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly keyframeChunkId: string | null;
  readonly oversizedSplit: boolean;
  readonly itemFamilyId?: string;
  readonly itemRevisionId?: string;
  readonly conceptIds?: readonly string[];
  readonly label?: string;
}

export interface TranscriptCueInput {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly keyframeChunkId?: string | null;
  readonly visibility?: PedagogicalVisibility;
  readonly conceptIds?: readonly string[];
  readonly itemFamilyId?: string;
  readonly label?: string;
}

export interface ChunkPedagogicalDocumentInput {
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly text: string;
  readonly privacyEpoch?: number;
  readonly pageSpans?: readonly PageSpan[];
  readonly itemFamilyId?: string;
  readonly itemRevisionId?: string;
  readonly conceptIds?: readonly string[];
  /**
   * Default visibility for unmarked blocks. Use "sealed" when quarantining
   * unclassified legacy chunks on the strict v3 ingestion path.
   */
  readonly defaultVisibility?: PedagogicalVisibility;
  /** Soft target for packing adjacent compatible blocks (default: 1200). */
  readonly maxChunkChars?: number;
  /**
   * Hard safety ceiling for a single atomic construct before deterministic
   * safe sub-splitting activates (default: 4000).
   */
  readonly maxSealedChars?: number;
  /** Propagate sealed/hint_gated visibility from explicit answer/hint headings (default: true). */
  readonly propagateSectionVisibility?: boolean;
}

export interface ChunkTranscriptCuesInput {
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly cues: readonly TranscriptCueInput[];
  readonly privacyEpoch?: number;
  readonly defaultVisibility?: PedagogicalVisibility;
  readonly maxSealedChars?: number;
}

export interface PedagogicalChunkPartition {
  readonly publicChunks: readonly PedagogicalChunk[];
  readonly hintGatedChunks: readonly PedagogicalChunk[];
  readonly sealedChunks: readonly PedagogicalChunk[];
  /** Strictly authorized indexable chunks (never includes `sealed`). */
  readonly indexableChunks: readonly PedagogicalChunk[];
}

export type SparseAdjacencyEntry = readonly [target: number, weight: number];
export type SparseTransitionGraph = ReadonlyArray<ReadonlyArray<SparseAdjacencyEntry>>;

export interface SparsePprOptions {
  /** Restart / damping probability alpha in (0, 1). Default: 0.15. */
  readonly alpha?: number;
  /** L1 convergence tolerance. Default: 1e-7. */
  readonly tolerance?: number;
  /** Upper bound on power iterations. Default: 32. */
  readonly maxIterations?: number;
}

export interface SparseWeightedEdge {
  readonly from: number;
  readonly to: number;
  readonly weight: number;
}

export type PedagogicalEdgeKind =
  | "prerequisite"
  | "requires"
  | "defines"
  | "states"
  | "proves"
  | "illustrates"
  | "uses_formula"
  | "next_step"
  | "applies_to"
  | "contains"
  | "solves";

export interface PedagogicalConceptNode {
  readonly id: string;
  readonly label: string;
  readonly kind?: "chapter" | "concept" | "procedure" | "problem_type";
  readonly supportingSourceIds?: readonly string[];
  readonly evidenceChunkIds?: readonly string[];
  readonly privacyEpoch?: number;
}

export interface PedagogicalGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: PedagogicalEdgeKind;
  readonly weight?: number;
  readonly sourceId?: string;
  readonly supportingSourceIds?: readonly string[];
  readonly supportingChunkIds?: readonly string[];
  readonly privacyEpoch?: number;
  readonly visibility?: PedagogicalVisibility;
}

export interface PedagogicalRetrievalAuthorization {
  readonly admissibleSourceIds: ReadonlySet<string> | readonly string[];
  readonly admissibleSourceVersions?: Readonly<Record<string, number>>;
  readonly expectedPrivacyEpoch?: number;
  /** Default false: hint_gated blocks are excluded unless explicitly granted. */
  readonly allowHintGated?: boolean;
  /** Problem families currently under independent evaluation (excluded pre-graph). */
  readonly excludedItemFamilyIds?: ReadonlySet<string> | readonly string[];
}

export interface ScoredCandidate {
  readonly id: string;
  readonly score: number;
}

export type CitationAnchor =
  | {
      readonly kind: "document";
      readonly sourceId: string;
      readonly sourceVersion: number;
      readonly chunkId: string;
      readonly physicalPage: number | null;
      readonly pageEnd: number | null;
      readonly startOffset: number;
      readonly endOffset: number;
    }
  | {
      readonly kind: "media";
      readonly sourceId: string;
      readonly sourceVersion: number;
      readonly chunkId: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly keyframeChunkId: string | null;
    };

export interface DualCitationBundle {
  readonly documentAnchors: readonly Extract<CitationAnchor, { kind: "document" }>[];
  readonly mediaAnchors: readonly Extract<CitationAnchor, { kind: "media" }>[];
}

export interface RankedPedagogicalChunk {
  readonly chunk: PedagogicalChunk;
  readonly seedScore: number;
  readonly pprScore: number;
  readonly prerequisiteBoost: number;
  readonly combinedScore: number;
  readonly citationAnchor: CitationAnchor;
}

export interface RankPedagogicalEvidenceOptions extends SparsePprOptions {
  readonly rrfK?: number;
  readonly seedWeight?: number;
  readonly pprWeight?: number;
  readonly prerequisiteWeight?: number;
  readonly maxResults?: number;
  readonly maxChunksPerItemFamily?: number;
  /** Place prerequisite / shared-concept definitions before dependent theorems. Default: true. */
  readonly orderFoundationsFirst?: boolean;
}

export interface RankPedagogicalEvidenceInput {
  readonly chunks: readonly PedagogicalChunk[];
  readonly concepts?: readonly PedagogicalConceptNode[];
  readonly edges?: readonly PedagogicalGraphEdge[];
  readonly lexicalRanking?: readonly ScoredCandidate[];
  readonly denseRanking?: readonly ScoredCandidate[];
  readonly seedScores?: Readonly<Record<string, number>>;
  readonly authorization: PedagogicalRetrievalAuthorization;
  readonly options?: RankPedagogicalEvidenceOptions;
}

export interface RankPedagogicalEvidenceDiagnostics {
  readonly totalInputChunks: number;
  readonly survivingChunks: number;
  readonly filteredSealedChunks: number;
  readonly filteredHintGatedChunks: number;
  readonly filteredUnauthorizedChunks: number;
  readonly filteredExcludedFamilyChunks: number;
  readonly survivingEdges: number;
  readonly filteredEdges: number;
  readonly totalPprMass: number;
}

export interface RankPedagogicalEvidenceResult {
  readonly ranked: readonly RankedPedagogicalChunk[];
  readonly citations: DualCitationBundle;
  readonly pprByNodeId: Readonly<Record<string, number>>;
  readonly diagnostics: RankPedagogicalEvidenceDiagnostics;
}
