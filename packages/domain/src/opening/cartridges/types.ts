import { z } from "zod";
import type { DistinguishableProbeSpec } from "./probe-protocol";

/**
 * Progressive TeachingCartridge capability levels. Each level strictly extends the
 * previous one; only L4 may contribute to formal evidence qualification.
 */
export const CARTRIDGE_CAPABILITY_LEVELS = [
  "L1_CONTINUITY",
  "L2_SCHEDULABLE",
  "L3_MATERIAL_REACTIVE",
  "L4_EVIDENCE",
] as const;
export type CartridgeCapabilityLevel = (typeof CARTRIDGE_CAPABILITY_LEVELS)[number];

export function cartridgeLevelRank(level: CartridgeCapabilityLevel): 1 | 2 | 3 | 4 {
  return (CARTRIDGE_CAPABILITY_LEVELS.indexOf(level) + 1) as 1 | 2 | 3 | 4;
}

/** True when `level` declares at least the `required` capability. */
export function meetsCapabilityLevel(level: CartridgeCapabilityLevel, required: CartridgeCapabilityLevel): boolean {
  return cartridgeLevelRank(level) >= cartridgeLevelRank(required);
}

export const cartridgeManifestSchema = z
  .object({
    /** Stable dotted identity, e.g. `408.stack.v1`. */
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    /** Semantic version of the cartridge implementation. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    domain: z.string().min(1).max(64),
    title: z.string().min(1).max(120),
    level: z.enum(CARTRIDGE_CAPABILITY_LEVELS),
  })
  .strict();
export type CartridgeManifest = z.infer<typeof cartridgeManifestSchema>;

export type CartridgeValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

export interface CartridgeResumeSummary {
  cartridgeId: string;
  cartridgeVersion: string;
  headline: string;
  completedSteps: number;
  totalSteps: number | null;
  /** Next requirement the learner can continue with; null when nothing is pending. */
  nextRequirementKey: string | null;
}

/* ---------------------------------------------------------------- L1 ---- */

/** L1: the cartridge can persist and restore its own continuity state. */
export interface ContinuityCartridge<TState = unknown> {
  readonly manifest: CartridgeManifest;
  serializeContinuityState(state: TState): string;
  /** Accepts serialized strings or plain values; never trusts unvalidated input. */
  parseContinuityState(raw: unknown): CartridgeValidationResult<TState>;
  buildResumeSummary(state: TState): CartridgeResumeSummary;
}

/* ---------------------------------------------------------------- L2 ---- */

export interface CartridgeActiveRetestWindow {
  requirementKey: string;
  /** ISO timestamps; `closesAt: null` keeps the window open until the host closes it. */
  opensAt: string;
  closesAt: string | null;
}

export type CartridgeTaskKind = "learn" | "practice" | "review";

export interface CartridgeTaskCandidate {
  candidateId: string;
  requirementKey: string;
  kind: CartridgeTaskKind;
  cadenceDays: number;
  earliestAt: string;
  priority: number;
}

export interface CartridgeScheduleInput<TState> {
  state: TState;
  /** Host-supplied ISO clock; cartridges never read wall-clock time. */
  now: string;
  activeRetestWindows: readonly CartridgeActiveRetestWindow[];
  limit?: number;
}

/** L2: deterministic task/cadence candidate projection. */
export interface SchedulableCartridge<TState = unknown> extends ContinuityCartridge<TState> {
  projectTaskCandidates(input: CartridgeScheduleInput<TState>): CartridgeTaskCandidate[];
}

/* ---------------------------------------------------------------- L3 ---- */

export interface CartridgeMaterialChunk {
  sourceId: string;
  sourceVersion: number;
  chunkId: string;
  page: number | null;
  text: string;
}

export interface CartridgeChunkBinding {
  requirementKey: string;
  sourceId: string;
  sourceVersion: number;
  chunkId: string;
  page: number | null;
  matchedTerms: string[];
}

export interface CartridgeCitation {
  sourceId: string;
  sourceVersion: number;
  chunkId: string;
  page: number | null;
  /** Exact substring of the cited chunk text. */
  quote: string;
}

export interface CartridgeExerciseSeed {
  seedId: string;
  requirementKey: string;
  prompt: string;
  citation: CartridgeCitation;
  parameters: Readonly<Record<string, string>>;
}

/** L3: binds supplied material chunks and extracts citation-grounded exercise seeds. */
export interface MaterialReactiveCartridge<TState = unknown> extends SchedulableCartridge<TState> {
  bindMaterialChunks(chunks: readonly CartridgeMaterialChunk[]): CartridgeChunkBinding[];
  extractExerciseSeeds(
    chunks: readonly CartridgeMaterialChunk[],
    bindings: readonly CartridgeChunkBinding[],
  ): CartridgeExerciseSeed[];
}

/* ---------------------------------------------------------------- L4 ---- */

export type CartridgeProbeDiagnosis = "correct_model" | "misconception" | "unclassified" | "invalid_response";

export interface CartridgeProbeEvaluation {
  probeId: string;
  requirementKey: string;
  outcome: "correct" | "incorrect" | "unverified";
  diagnosis: CartridgeProbeDiagnosis;
  /** Hypothesis whose prediction matches the response; at most one for a verified probe. */
  matchedHypothesisId: string | null;
  observableKey: string | null;
}

export interface CartridgeEvidenceContract {
  evaluatorVersion: string;
  specVersion: string;
}

/** L4: distinguishable misconception probes and formal evidence gating. */
export interface EvidenceCartridge<TState = unknown> extends MaterialReactiveCartridge<TState> {
  readonly evidenceContract: CartridgeEvidenceContract;
  listProbes(): readonly DistinguishableProbeSpec<unknown, unknown>[];
  getProbe(probeId: string): DistinguishableProbeSpec<unknown, unknown> | null;
  evaluateProbeResponse(probeId: string, response: unknown): CartridgeProbeEvaluation;
}

export type AnyTeachingCartridge = ContinuityCartridge<unknown>;

/* ------------------------------------------------------- type guards ---- */

function hasMethods(value: object, names: readonly string[]): boolean {
  return names.every(name => typeof (value as Record<string, unknown>)[name] === "function");
}

const L1_METHODS = ["serializeContinuityState", "parseContinuityState", "buildResumeSummary"] as const;
const L2_METHODS = ["projectTaskCandidates"] as const;
const L3_METHODS = ["bindMaterialChunks", "extractExerciseSeeds"] as const;
const L4_METHODS = ["listProbes", "getProbe", "evaluateProbeResponse"] as const;

export const CARTRIDGE_LEVEL_METHODS: Readonly<Record<CartridgeCapabilityLevel, readonly string[]>> = {
  L1_CONTINUITY: L1_METHODS,
  L2_SCHEDULABLE: [...L1_METHODS, ...L2_METHODS],
  L3_MATERIAL_REACTIVE: [...L1_METHODS, ...L2_METHODS, ...L3_METHODS],
  L4_EVIDENCE: [...L1_METHODS, ...L2_METHODS, ...L3_METHODS, ...L4_METHODS],
};

function declares(cartridge: AnyTeachingCartridge, level: CartridgeCapabilityLevel): boolean {
  try {
    const parsed = cartridgeManifestSchema.safeParse(cartridge.manifest);
    return parsed.success && meetsCapabilityLevel(parsed.data.level, level)
      && hasMethods(cartridge, CARTRIDGE_LEVEL_METHODS[level]);
  } catch {
    return false;
  }
}

export function hasSchedulableCapability<TState>(
  cartridge: ContinuityCartridge<TState>,
): cartridge is SchedulableCartridge<TState> {
  return declares(cartridge as AnyTeachingCartridge, "L2_SCHEDULABLE");
}

export function hasMaterialReactiveCapability<TState>(
  cartridge: ContinuityCartridge<TState>,
): cartridge is MaterialReactiveCartridge<TState> {
  return declares(cartridge as AnyTeachingCartridge, "L3_MATERIAL_REACTIVE");
}

export function hasEvidenceCapability<TState>(
  cartridge: ContinuityCartridge<TState>,
): cartridge is EvidenceCartridge<TState> {
  try {
    const evidence = (cartridge as Partial<EvidenceCartridge<TState>>).evidenceContract;
    return declares(cartridge as AnyTeachingCartridge, "L4_EVIDENCE")
      && Boolean(evidence?.evaluatorVersion && evidence.specVersion);
  } catch {
    return false;
  }
}

/** Format an unknown thrown value into a string without ever throwing a secondary error. */
export function safeErrorDetail(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message === "string" && message.length > 0) return message;
      const name = error.name;
      if (typeof name === "string" && name.length > 0) return name;
    }
  } catch {
    // Fall through to safe string coercion below.
  }
  try {
    return String(error);
  } catch {
    return "unprintable thrown value";
  }
}
