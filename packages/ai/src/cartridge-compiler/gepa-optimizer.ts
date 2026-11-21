import {
  ALLOWED_GEPA_MUTATION_SURFACES,
  FORBIDDEN_GEPA_MUTATION_SURFACES,
  GepaForbiddenSurfaceError,
  HoldoutFirewallError,
  InvalidRubricAnchorPairError,
  type CartridgeCandidateMetrics,
  type CartridgeDeclarativePolicy,
  type CartridgeHintStep,
  type CartridgeMoveRule,
  type ClusteringOptions,
  type DisjointDatasetSplit,
  type ErrorTrajectoryRecord,
  type GepaOptimizationRoundResult,
  type GepaProposedCandidate,
  type GepaReflectionContext,
  type GepaSurfacePatch,
  type HoldoutFirewall,
  type MisconceptionRubricRule,
  type ParetoEvaluationOptions,
} from "./types";
import {
  assertPseudonymizedTrajectory,
  clusterErrorTrajectories,
  validateRubricAnchorPair,
} from "./clustering";
import { evaluateParetoFrontierAndPromotion } from "./pareto";

const ALLOWED_SURFACE_SET: ReadonlySet<string> = new Set(ALLOWED_GEPA_MUTATION_SURFACES);
const FORBIDDEN_SURFACE_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_GEPA_MUTATION_SURFACES.map((s) => s.toLowerCase()),
);

function deterministicHash32(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function sortedBySeedHash(values: readonly string[], seed: number, salt: string): string[] {
  return [...values].sort((a, b) => {
    const ha = deterministicHash32(`${seed}:${salt}:${a}`);
    const hb = deterministicHash32(`${seed}:${salt}:${b}`);
    if (ha !== hb) return ha - hb;
    return a.localeCompare(b);
  });
}

export interface DisjointSplitOptions {
  readonly seed?: number;
  /** Target fraction of trajectories/entities reserved for holdout (default 0.25). */
  readonly holdoutRatio?: number;
  /** Target fraction of remaining train+dev trajectories reserved for dev (default 0.25). */
  readonly devRatio?: number;
}

/**
 * Verifies strict (learnerPseudoId, itemFamilyId) disjointness between `holdout`
 * and `train`/`dev`. Throws `HoldoutFirewallError` on any violation.
 */
export function assertDisjointSplitInvariants(split: DisjointDatasetSplit): void {
  const holdoutTrajIds = new Set(split.holdout.map((t) => t.trajectoryId));
  const holdoutLearners = new Set(split.holdout.map((t) => t.learnerPseudoId));
  const holdoutFamilies = new Set(split.holdout.map((t) => t.itemFamilyId));

  const leakedTrajectoryIds: string[] = [];
  const leakedLearners = new Set<string>();
  const leakedFamilies = new Set<string>();

  for (const record of [...split.train, ...split.dev]) {
    let violated = false;
    if (holdoutTrajIds.has(record.trajectoryId)) {
      violated = true;
    }
    if (holdoutLearners.has(record.learnerPseudoId)) {
      leakedLearners.add(record.learnerPseudoId);
      violated = true;
    }
    if (holdoutFamilies.has(record.itemFamilyId)) {
      leakedFamilies.add(record.itemFamilyId);
      violated = true;
    }
    if (violated) {
      leakedTrajectoryIds.push(record.trajectoryId);
    }
  }

  if (leakedTrajectoryIds.length > 0 || leakedLearners.size > 0 || leakedFamilies.size > 0) {
    throw new HoldoutFirewallError(
      `Disjoint split invariant violated: holdout overlaps train/dev on ${leakedLearners.size} learner(s) and ${leakedFamilies.size} itemFamily(ies).`,
      leakedTrajectoryIds,
      [...leakedLearners].sort((a, b) => a.localeCompare(b)),
      [...leakedFamilies].sort((a, b) => a.localeCompare(b)),
    );
  }
}

/**
 * Partitions trajectories into `train`, `dev`, and `holdout` such that NO
 * `learnerPseudoId` AND NO `itemFamilyId` appearing in `holdout` ever appears
 * in `train` or `dev`.
 *
 * Strategy:
 * 1) Decompose the `(learnerPseudoId <-> itemFamilyId)` bipartite graph into
 *    connected components. When >= 2 components exist, holdout takes whole
 *    components deterministically (zero quarantined trajectories).
 * 2) When all trajectories belong to a single dense connected component, select
 *    deterministic holdout subsets `(H_L, H_F)` so `holdout = H_L x H_F`,
 *    `train+dev = (L \ H_L) x (F \ H_F)`, and crossing records are isolated in
 *    `quarantinedCrossing` (excluded from both holdout and train/dev).
 */
export function createDisjointTrajectorySplit(
  trajectories: readonly ErrorTrajectoryRecord[],
  options: DisjointSplitOptions = {},
): DisjointDatasetSplit {
  for (const t of trajectories) {
    assertPseudonymizedTrajectory(t);
  }

  const seed = options.seed ?? 20261121;
  const holdoutRatio = Math.min(0.5, Math.max(0.1, options.holdoutRatio ?? 0.25));
  const devRatio = Math.min(0.5, Math.max(0.1, options.devRatio ?? 0.25));

  if (trajectories.length === 0) {
    return {
      train: [],
      dev: [],
      holdout: [],
      quarantinedCrossing: [],
      holdoutFirewall: {
        holdoutTrajectoryIds: [],
        holdoutLearnerPseudoIds: [],
        holdoutItemFamilyIds: [],
      },
    };
  }

  // Union-Find over bipartite nodes ("L:<id>" and "F:<id>")
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr) ?? root;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      if (ra < rb) parent.set(rb, ra);
      else parent.set(ra, rb);
    }
  };

  for (const t of trajectories) {
    union(`L:${t.learnerPseudoId}`, `F:${t.itemFamilyId}`);
  }

  const componentsMap = new Map<string, ErrorTrajectoryRecord[]>();
  for (const t of trajectories) {
    const root = find(`L:${t.learnerPseudoId}`);
    const list = componentsMap.get(root);
    if (list) list.push(t);
    else componentsMap.set(root, [t]);
  }

  const componentKeys = sortedBySeedHash([...componentsMap.keys()], seed, "component");

  let holdout: ErrorTrajectoryRecord[] = [];
  let trainDevPool: ErrorTrajectoryRecord[] = [];
  let quarantinedCrossing: ErrorTrajectoryRecord[] = [];

  if (componentKeys.length >= 2) {
    const targetHoldoutCount = Math.max(1, Math.round(trajectories.length * holdoutRatio));
    for (let i = 0; i < componentKeys.length; i += 1) {
      const key = componentKeys[i]!;
      const members = componentsMap.get(key) ?? [];
      const remainingComponents = componentKeys.length - i - 1;
      if (holdout.length < targetHoldoutCount && remainingComponents >= 1) {
        holdout.push(...members);
      } else {
        trainDevPool.push(...members);
      }
    }
  } else {
    // Dense single component: deterministic 2D block split H_L x H_F vs (L\H_L) x (F\H_F)
    const uniqueLearners = sortedBySeedHash(
      [...new Set(trajectories.map((t) => t.learnerPseudoId))],
      seed,
      "learner",
    );
    const uniqueFamilies = sortedBySeedHash(
      [...new Set(trajectories.map((t) => t.itemFamilyId))],
      seed,
      "family",
    );

    if (uniqueLearners.length >= 2 && uniqueFamilies.length >= 2) {
      const holdoutLearnerCount = Math.min(
        uniqueLearners.length - 1,
        Math.max(1, Math.round(uniqueLearners.length * Math.sqrt(holdoutRatio))),
      );
      const holdoutFamilyCount = Math.min(
        uniqueFamilies.length - 1,
        Math.max(1, Math.round(uniqueFamilies.length * Math.sqrt(holdoutRatio))),
      );

      const holdoutLearnerSet = new Set(uniqueLearners.slice(0, holdoutLearnerCount));
      const holdoutFamilySet = new Set(uniqueFamilies.slice(0, holdoutFamilyCount));

      // Ensure at least one record falls inside H_L x H_F; if sparse within component, expand minimally.
      let candidateHoldout = trajectories.filter(
        (t) => holdoutLearnerSet.has(t.learnerPseudoId) && holdoutFamilySet.has(t.itemFamilyId),
      );
      if (candidateHoldout.length === 0) {
        const anchor = trajectories[0]!;
        holdoutLearnerSet.clear();
        holdoutFamilySet.clear();
        holdoutLearnerSet.add(anchor.learnerPseudoId);
        holdoutFamilySet.add(anchor.itemFamilyId);
        candidateHoldout = trajectories.filter(
          (t) => holdoutLearnerSet.has(t.learnerPseudoId) && holdoutFamilySet.has(t.itemFamilyId),
        );
      }

      holdout = candidateHoldout;
      trainDevPool = trajectories.filter(
        (t) => !holdoutLearnerSet.has(t.learnerPseudoId) && !holdoutFamilySet.has(t.itemFamilyId),
      );
      quarantinedCrossing = trajectories.filter(
        (t) =>
          (holdoutLearnerSet.has(t.learnerPseudoId) && !holdoutFamilySet.has(t.itemFamilyId)) ||
          (!holdoutLearnerSet.has(t.learnerPseudoId) && holdoutFamilySet.has(t.itemFamilyId)),
      );
    } else {
      // Degenerate dataset with only 1 unique learner or 1 unique family: cannot disjointly split both axes;
      // keep all in trainDevPool so holdout firewall never falsely claims disjointness.
      trainDevPool = [...trajectories];
    }
  }

  // Partition trainDevPool into train and dev deterministically by learnerPseudoId.
  const trainDevLearners = sortedBySeedHash(
    [...new Set(trainDevPool.map((t) => t.learnerPseudoId))],
    seed,
    "dev_learner",
  );
  const devLearnerCount =
    trainDevLearners.length >= 2
      ? Math.min(trainDevLearners.length - 1, Math.max(1, Math.round(trainDevLearners.length * devRatio)))
      : 0;
  const devLearnerSet = new Set(trainDevLearners.slice(0, devLearnerCount));

  const dev = trainDevPool.filter((t) => devLearnerSet.has(t.learnerPseudoId));
  const train = trainDevPool.filter((t) => !devLearnerSet.has(t.learnerPseudoId));

  const holdoutFirewall: HoldoutFirewall = {
    holdoutTrajectoryIds: [...new Set(holdout.map((t) => t.trajectoryId))].sort((a, b) =>
      a.localeCompare(b),
    ),
    holdoutLearnerPseudoIds: [...new Set(holdout.map((t) => t.learnerPseudoId))].sort((a, b) =>
      a.localeCompare(b),
    ),
    holdoutItemFamilyIds: [...new Set(holdout.map((t) => t.itemFamilyId))].sort((a, b) =>
      a.localeCompare(b),
    ),
  };

  const split: DisjointDatasetSplit = {
    train,
    dev,
    holdout,
    quarantinedCrossing,
    holdoutFirewall,
  };
  assertDisjointSplitInvariants(split);
  return split;
}

/**
 * Enforces the GEPA Holdout Firewall: throws a deterministic `HoldoutFirewallError`
 * if ANY trajectory passed into reflective mutation shares a `trajectoryId`,
 * `learnerPseudoId`, or `itemFamilyId` with `holdout`.
 */
export function assertNoHoldoutLeakage(
  trajectories: readonly ErrorTrajectoryRecord[],
  firewall: HoldoutFirewall,
): void {
  const blockedTrajectoryIds = new Set(firewall.holdoutTrajectoryIds);
  const blockedLearners = new Set(firewall.holdoutLearnerPseudoIds);
  const blockedFamilies = new Set(firewall.holdoutItemFamilyIds);

  const leakedTrajectoryIds: string[] = [];
  const leakedLearners = new Set<string>();
  const leakedFamilies = new Set<string>();

  for (const t of trajectories) {
    let hit = false;
    if (blockedTrajectoryIds.has(t.trajectoryId)) {
      hit = true;
    }
    if (blockedLearners.has(t.learnerPseudoId)) {
      leakedLearners.add(t.learnerPseudoId);
      hit = true;
    }
    if (blockedFamilies.has(t.itemFamilyId)) {
      leakedFamilies.add(t.itemFamilyId);
      hit = true;
    }
    if (hit) {
      leakedTrajectoryIds.push(t.trajectoryId);
    }
  }

  if (leakedTrajectoryIds.length > 0 || leakedLearners.size > 0 || leakedFamilies.size > 0) {
    throw new HoldoutFirewallError(
      `Holdout firewall blocked GEPA reflective access: trajectories=[${leakedTrajectoryIds.join(",")}], learners=[${[...leakedLearners].join(",")}], families=[${[...leakedFamilies].join(",")}]`,
      leakedTrajectoryIds,
      [...leakedLearners].sort((a, b) => a.localeCompare(b)),
      [...leakedFamilies].sort((a, b) => a.localeCompare(b)),
    );
  }
}

function scanObjectForForbiddenSurfaceKeys(value: unknown, pathPrefix: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = scanObjectForForbiddenSurfaceKeys(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SURFACE_SET.has(key.toLowerCase())) {
      return `${pathPrefix}.${key}`;
    }
    const hit = scanObjectForForbiddenSurfaceKeys(nested, `${pathPrefix}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Validates that a GEPA mutation patch targets ONLY an allowed declarative surface
 * (`moveRules`, `hintLadder`, `rubricAnchors`, `approvedTemplateSlots`) and NEVER
 * touches `permissions`, `answerVisibility`, `gradingWriteAuthority`, or `leakageDetectors`.
 */
export function assertAllowedGepaPatch(patch: unknown): asserts patch is GepaSurfacePatch {
  if (!patch || typeof patch !== "object") {
    throw new GepaForbiddenSurfaceError("GEPA patch must be a non-null object", "invalid");
  }
  const raw = patch as Record<string, unknown>;
  const surface = raw.surface;
  if (typeof surface !== "string" || !ALLOWED_SURFACE_SET.has(surface)) {
    throw new GepaForbiddenSurfaceError(
      `GEPA patch attempted to mutate forbidden or unknown surface "${String(surface)}". Allowed surfaces: ${ALLOWED_GEPA_MUTATION_SURFACES.join(", ")}`,
      String(surface),
    );
  }

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_SURFACE_SET.has(key.toLowerCase())) {
      throw new GepaForbiddenSurfaceError(
        `GEPA patch contains forbidden authority key "${key}"`,
        key,
      );
    }
  }

  const nestedHit = scanObjectForForbiddenSurfaceKeys(raw.payload, surface);
  if (nestedHit) {
    throw new GepaForbiddenSurfaceError(
      `GEPA patch payload attempted to smuggle forbidden authority surface at "${nestedHit}"`,
      nestedHit,
    );
  }
}

function bumpPolicyVersion(version: string, suffix: string): string {
  return `${version}+${suffix}`;
}

/**
 * Applies a validated declarative patch to a cartridge policy, returning a new
 * immutable policy. Rejects forbidden surfaces and invalid rubric anchor pairs.
 */
export function validateAndApplyGepaPatch(
  policy: CartridgeDeclarativePolicy,
  patch: unknown,
  versionTag = "gepa",
): CartridgeDeclarativePolicy {
  assertAllowedGepaPatch(patch);

  switch (patch.surface) {
    case "moveRules": {
      const merged = new Map<string, CartridgeMoveRule>(policy.moveRules.map((r) => [r.id, r]));
      for (const rule of patch.payload) {
        merged.set(rule.id, { ...rule });
      }
      const sortedRules = [...merged.values()].sort((a, b) =>
        b.priority !== a.priority ? b.priority - a.priority : a.id.localeCompare(b.id),
      );
      return {
        ...policy,
        version: bumpPolicyVersion(policy.version, versionTag),
        moveRules: sortedRules,
      };
    }

    case "hintLadder": {
      const merged = new Map<string, CartridgeHintStep>(
        policy.hintLadder.map((h) => [`${h.conceptId}::${h.stage}`, h]),
      );
      for (const step of patch.payload) {
        merged.set(`${step.conceptId}::${step.stage}`, { ...step });
      }
      const sortedHints = [...merged.values()].sort((a, b) => {
        const cmp = a.conceptId.localeCompare(b.conceptId);
        return cmp !== 0 ? cmp : a.stage - b.stage;
      });
      return {
        ...policy,
        version: bumpPolicyVersion(policy.version, versionTag),
        hintLadder: sortedHints,
      };
    }

    case "rubricAnchors": {
      for (const rule of patch.payload) {
        const check = validateRubricAnchorPair(rule);
        if (!check.valid) {
          throw new InvalidRubricAnchorPairError(
            `Rubric anchor rule "${rule.ruleId}" failed positive/negative anchor validation: ${check.issues.join(" ")}`,
            rule.ruleId,
            check.issues,
          );
        }
      }
      const merged = new Map<string, MisconceptionRubricRule>(
        policy.rubricAnchors.map((r) => [r.ruleId, r]),
      );
      for (const rule of patch.payload) {
        merged.set(rule.ruleId, rule);
      }
      const sortedRubrics = [...merged.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
      return {
        ...policy,
        version: bumpPolicyVersion(policy.version, versionTag),
        rubricAnchors: sortedRubrics,
      };
    }

    case "approvedTemplateSlots": {
      return {
        ...policy,
        version: bumpPolicyVersion(policy.version, versionTag),
        approvedTemplateSlots: {
          ...policy.approvedTemplateSlots,
          ...patch.payload,
        },
      };
    }
  }
}

export interface BuildGepaReflectionInput {
  readonly policy: CartridgeDeclarativePolicy;
  readonly trainTrajectories: readonly ErrorTrajectoryRecord[];
  readonly devTrajectories: readonly ErrorTrajectoryRecord[];
  readonly holdoutFirewall: HoldoutFirewall;
  readonly clusteringOptions?: ClusteringOptions;
}

/**
 * Builds the sanitized reflective prompt context for GEPA mutation.
 * Enforces the holdout firewall on BOTH train and dev trajectories before clustering.
 */
export function buildGepaReflectionContext(
  input: BuildGepaReflectionInput,
): GepaReflectionContext {
  assertNoHoldoutLeakage(input.trainTrajectories, input.holdoutFirewall);
  assertNoHoldoutLeakage(input.devTrajectories, input.holdoutFirewall);

  const summary = clusterErrorTrajectories(input.trainTrajectories, input.clusteringOptions);
  return {
    policyId: input.policy.policyId,
    policyVersion: input.policy.version,
    trainTrajectoryCount: input.trainTrajectories.length,
    devTrajectoryCount: input.devTrajectories.length,
    actionableClusters: summary.actionableClusters.map((c) => ({
      clusterId: c.clusterId,
      conceptId: c.conceptId,
      firstErrorRuleId: c.firstErrorRuleId,
      centroidAstEdit: c.centroidAstEdit,
      missingPremise: c.missingPremise,
      supportCount: c.supportCount,
      uniqueLearnerCount: c.uniqueLearnerCount,
      itemFamilyIds: c.itemFamilyIds,
    })),
    observationOnlyClusterCount: summary.observationOnlyClusters.length,
    allowedSurfaces: ALLOWED_GEPA_MUTATION_SURFACES,
    currentPolicy: input.policy,
  };
}

/**
 * Deterministically proposes candidate declarative patches over allowed GEPA
 * surfaces (`moveRules`, `hintLadder`, `rubricAnchors`, `approvedTemplateSlots`)
 * derived strictly from actionable clusters in the sanitized reflection context.
 */
export function proposeGepaReflectivePatches(
  context: GepaReflectionContext,
): readonly GepaProposedCandidate[] {
  const candidates: GepaProposedCandidate[] = [];
  const basePolicy = context.currentPolicy;

  for (let i = 0; i < context.actionableClusters.length; i += 1) {
    const cluster = context.actionableClusters[i]!;
    const suffix = `c${i + 1}`;
    const astTokens = cluster.centroidAstEdit
      .split("|")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const primaryToken = astTokens[0] ?? "ERROR_STEP";

    const movePatch: GepaSurfacePatch = {
      surface: "moveRules",
      summary: `Add targeted premise-check move rule for ${cluster.firstErrorRuleId}`,
      payload: [
        {
          id: `rule_${cluster.conceptId}_${cluster.firstErrorRuleId}`,
          conceptId: cluster.conceptId,
          triggerRuleId: cluster.firstErrorRuleId,
          missingPremise: cluster.missingPremise,
          move: "targeted_scaffold",
          priority: 100 + cluster.supportCount,
        },
      ],
    };

    const hintPatch: GepaSurfacePatch = {
      surface: "hintLadder",
      summary: `Add non-leaky premise cue at stage 1 for ${cluster.conceptId}`,
      payload: [
        {
          stage: 1,
          conceptId: cluster.conceptId,
          cueTemplate: `Before applying ${cluster.firstErrorRuleId}, verify premise (${cluster.missingPremise}).`,
          revealsPremiseCheck: true,
        },
      ],
    };

    const rubricRule: MisconceptionRubricRule = {
      ruleId: `rubric_${cluster.conceptId}_${cluster.firstErrorRuleId}`,
      conceptId: cluster.conceptId,
      firstErrorRuleId: cluster.firstErrorRuleId,
      requiredAstTokens: [primaryToken],
      requiredMissingPremise: cluster.missingPremise,
      positiveAnchors: [
        {
          anchorId: `pos_${cluster.clusterId}`,
          label: "positive",
          conceptId: cluster.conceptId,
          firstErrorRuleId: cluster.firstErrorRuleId,
          normalizedAstEdit: cluster.centroidAstEdit,
          establishedPremises: [],
          expression: `${cluster.centroidAstEdit} [without ${cluster.missingPremise}]`,
          rationale: `Applies ${cluster.firstErrorRuleId} while omitting required premise (${cluster.missingPremise}).`,
        },
      ],
      negativeAnchors: [
        {
          anchorId: `neg_${cluster.clusterId}`,
          label: "negative",
          conceptId: cluster.conceptId,
          firstErrorRuleId: cluster.firstErrorRuleId,
          normalizedAstEdit: cluster.centroidAstEdit,
          establishedPremises: [cluster.missingPremise],
          expression: `${cluster.centroidAstEdit} [given ${cluster.missingPremise}]`,
          rationale: `Valid derivation because required premise (${cluster.missingPremise}) is explicitly established.`,
        },
      ],
    };

    const rubricPatch: GepaSurfacePatch = {
      surface: "rubricAnchors",
      summary: `Register validated positive/negative rubric anchor pair for ${cluster.firstErrorRuleId}`,
      payload: [rubricRule],
    };

    const slotPatch: GepaSurfacePatch = {
      surface: "approvedTemplateSlots",
      summary: `Populate approved premise slot for ${cluster.conceptId}`,
      payload: {
        [`premise_prompt_${cluster.conceptId}`]: `Check whether "${cluster.missingPremise}" holds before that transformation.`,
      },
    };

    let mutated = validateAndApplyGepaPatch(basePolicy, movePatch, `${suffix}_move`);
    mutated = validateAndApplyGepaPatch(mutated, hintPatch, `${suffix}_hint`);
    mutated = validateAndApplyGepaPatch(mutated, rubricPatch, `${suffix}_rubric`);
    mutated = validateAndApplyGepaPatch(mutated, slotPatch, `${suffix}_slot`);

    candidates.push({
      candidateId: `${basePolicy.policyId}__gepa_${suffix}`,
      policy: {
        ...mutated,
        policyId: `${basePolicy.policyId}__gepa_${suffix}`,
      },
      appliedPatches: [movePatch, hintPatch, rubricPatch, slotPatch],
    });
  }

  return candidates;
}

export interface RunGepaOptimizationRoundInput {
  readonly basePolicy: CartridgeDeclarativePolicy;
  readonly split: DisjointDatasetSplit;
  readonly clusteringOptions?: ClusteringOptions;
  readonly extraCandidatePatches?: readonly {
    readonly candidateId: string;
    readonly patches: readonly unknown[];
  }[];
  /**
   * Scores each candidate policy to produce exact `(C, -L, T7)` metrics.
   * Called separately from reflection so holdout trajectories are never exposed
   * to the GEPA reflective context.
   */
  readonly scoreCandidate: (
    candidate: GepaProposedCandidate,
  ) => CartridgeCandidateMetrics;
  readonly paretoOptions: ParetoEvaluationOptions;
}

export function runGepaOptimizationRound(
  input: RunGepaOptimizationRoundInput,
): GepaOptimizationRoundResult {
  assertDisjointSplitInvariants(input.split);

  const reflectionContext = buildGepaReflectionContext({
    policy: input.basePolicy,
    trainTrajectories: input.split.train,
    devTrajectories: input.split.dev,
    holdoutFirewall: input.split.holdoutFirewall,
    clusteringOptions: input.clusteringOptions,
  });

  const proposed: GepaProposedCandidate[] = [
    ...proposeGepaReflectivePatches(reflectionContext),
  ];

  for (const extra of input.extraCandidatePatches ?? []) {
    let policy = input.basePolicy;
    const applied: GepaSurfacePatch[] = [];
    for (let i = 0; i < extra.patches.length; i += 1) {
      const rawPatch = extra.patches[i];
      policy = validateAndApplyGepaPatch(policy, rawPatch, `ext_${i + 1}`);
      applied.push(rawPatch as GepaSurfacePatch);
    }
    proposed.push({
      candidateId: extra.candidateId,
      policy: { ...policy, policyId: extra.candidateId },
      appliedPatches: applied,
    });
  }

  const candidateMetrics = proposed.map((candidate) => input.scoreCandidate(candidate));
  const pareto = evaluateParetoFrontierAndPromotion(candidateMetrics, input.paretoOptions);

  return {
    reflectionContext,
    candidates: proposed,
    pareto,
  };
}
