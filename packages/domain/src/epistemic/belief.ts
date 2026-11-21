/**
 * HSRS-FIRe-DCM is a closed-core engine. Its state is intentionally a
 * browser-safe JSON value so it can be evaluated in a deterministic client or
 * server process without importing persistence, network, or native modules.
 */

export const DAY_MS = 86_400_000;
export const DEFAULT_CURVE_EXPONENT = -0.5;
export const DEFAULT_FAMILY_PRIOR = 0.5;
export const DEFAULT_VARIANCE_MIN = 0.02;
export const DEFAULT_VARIANCE_MAX = 4;
export const DEFAULT_LOG_STABILITY_MIN = -6;
export const DEFAULT_LOG_STABILITY_MAX = 8;
export const MAX_IMPLICIT_LOG_CREDIT = Math.log(1.2);

export type MisconceptionMass = ReadonlyArray<readonly [id: string, mass: number]>;

export type SkillBeliefV1 = {
  schemaVersion: 1;
  workspaceId: string;
  learnerId: string;
  courseId: string;
  confirmedSkillVersion: string | number;
  logStability: number;
  abilityMean: number;
  abilityVariance: number;
  lastDirectRecallAtMs: number | null;
  implicitLogCredit: number;
  misconceptionMass: MisconceptionMass;
  otherMass: number;
};

export type BeliefBounds = {
  varianceMin?: number;
  varianceMax?: number;
  logStabilityMin?: number;
  logStabilityMax?: number;
};

const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function normalizedMass(input: MisconceptionMass | undefined, otherMass: number | undefined): { misconceptionMass: MisconceptionMass; otherMass: number } {
  const grouped = new Map<string, number>();
  for (const pair of input ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !pair[0] || !Number.isFinite(pair[1]) || pair[1] <= 0) continue;
    grouped.set(pair[0], (grouped.get(pair[0]) ?? 0) + pair[1]);
  }
  const sorted = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  const misconceptionTotal = sorted.reduce((sum, [, mass]) => sum + mass, 0);
  const requestedOther = Number.isFinite(otherMass) && (otherMass as number) > 0 ? otherMass as number : 1;
  const total = misconceptionTotal + requestedOther;
  if (!(total > 0)) return { misconceptionMass: [], otherMass: 1 };
  return {
    misconceptionMass: sorted.map(([id, mass]) => [id, mass / total] as const),
    otherMass: requestedOther / total,
  };
}

export function createSkillBelief(input: {
  workspaceId: string;
  learnerId: string;
  courseId: string;
  confirmedSkillVersion: string | number;
  logStability?: number;
  abilityMean?: number;
  abilityVariance?: number;
  lastDirectRecallAtMs?: number | null;
  implicitLogCredit?: number;
  misconceptionMass?: MisconceptionMass;
  otherMass?: number;
}, bounds: BeliefBounds = {}): SkillBeliefV1 {
  const varianceMin = finite(bounds.varianceMin ?? DEFAULT_VARIANCE_MIN, DEFAULT_VARIANCE_MIN);
  const varianceMax = Math.max(varianceMin, finite(bounds.varianceMax ?? DEFAULT_VARIANCE_MAX, DEFAULT_VARIANCE_MAX));
  const stabilityMin = finite(bounds.logStabilityMin ?? DEFAULT_LOG_STABILITY_MIN, DEFAULT_LOG_STABILITY_MIN);
  const stabilityMax = Math.max(stabilityMin, finite(bounds.logStabilityMax ?? DEFAULT_LOG_STABILITY_MAX, DEFAULT_LOG_STABILITY_MAX));
  const mass = normalizedMass(input.misconceptionMass, input.otherMass);
  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    learnerId: input.learnerId,
    courseId: input.courseId,
    confirmedSkillVersion: input.confirmedSkillVersion,
    logStability: clamp(finite(input.logStability ?? Math.log(10), Math.log(10)), stabilityMin, stabilityMax),
    abilityMean: finite(input.abilityMean ?? 0, 0),
    abilityVariance: clamp(finite(input.abilityVariance ?? 1, 1), varianceMin, varianceMax),
    lastDirectRecallAtMs: input.lastDirectRecallAtMs == null ? null : finite(input.lastDirectRecallAtMs, 0),
    implicitLogCredit: clamp(finite(input.implicitLogCredit ?? 0, 0), 0, MAX_IMPLICIT_LOG_CREDIT),
    misconceptionMass: mass.misconceptionMass,
    otherMass: mass.otherMass,
  };
}

export function normalizeSkillBelief(belief: SkillBeliefV1, bounds: BeliefBounds = {}): SkillBeliefV1 {
  return createSkillBelief(belief, bounds);
}

export function powerLawRetrievability(input: {
  logStability: number;
  atMs: number;
  lastDirectRecallAtMs: number | null;
  implicitLogCredit?: number;
  curveExponent?: number;
  familyPrior?: number;
}): number {
  if (input.lastDirectRecallAtMs == null) return clamp(input.familyPrior ?? DEFAULT_FAMILY_PRIOR, 0, 1);
  const exponent = input.curveExponent ?? DEFAULT_CURVE_EXPONENT;
  if (!(exponent < 0) || !Number.isFinite(exponent)) throw new RangeError("curveExponent must be negative");
  const interval = Math.max(0, input.atMs - input.lastDirectRecallAtMs) / DAY_MS;
  const factor = Math.pow(0.9, 1 / exponent) - 1;
  const denominator = Math.exp(input.logStability + (input.implicitLogCredit ?? 0));
  return clamp(Math.pow(1 + factor * interval / denominator, exponent), 0, 1);
}

/** Direct evidence always uses c=0 unless useImplicitCredit is explicitly requested. */
export function retrievability(belief: SkillBeliefV1, atMs: number, options: { familyPrior?: number } = {}): number {
  return powerLawRetrievability({ logStability: belief.logStability, atMs, lastDirectRecallAtMs: belief.lastDirectRecallAtMs, familyPrior: options.familyPrior });
}

export function effectiveRetrievability(belief: SkillBeliefV1, atMs: number, options: { familyPrior?: number } = {}): number {
  return powerLawRetrievability({ logStability: belief.logStability, atMs, lastDirectRecallAtMs: belief.lastDirectRecallAtMs, implicitLogCredit: belief.implicitLogCredit, familyPrior: options.familyPrior });
}

export function withBeliefBounds(belief: SkillBeliefV1, patch: Partial<SkillBeliefV1>, bounds: BeliefBounds = {}): SkillBeliefV1 {
  return normalizeSkillBelief({ ...belief, ...patch, schemaVersion: 1 }, bounds);
}
