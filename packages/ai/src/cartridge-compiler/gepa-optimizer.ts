import {
  ALLOWED_GEPA_MUTATION_SURFACES,
  CandidateIdentityError,
  FORBIDDEN_GEPA_MUTATION_SURFACES,
  GepaForbiddenSurfaceError,
  GepaInvalidPatchPayloadError,
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
  assertNoRawPiiInText,
  assertNoRawPiiInValue,
  assertPseudonymizedTrajectory,
  canonicalizeIdentifier,
  canonicalizeTrajectoryRecord,
  clusterErrorTrajectories,
  normalizeAstEdit,
  validateRubricAnchorPair,
} from "./clustering";
import { evaluateParetoFrontierAndPromotion } from "./pareto";

const ALLOWED_SURFACE_SET: ReadonlySet<string> = new Set(ALLOWED_GEPA_MUTATION_SURFACES);
const FORBIDDEN_SURFACE_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_GEPA_MUTATION_SURFACES.map((s) => s.toLowerCase()),
);
const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PATCH_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["surface", "summary", "payload"]);
const MOVE_RULE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "conceptId",
  "triggerRuleId",
  "missingPremise",
  "move",
  "priority",
]);
const HINT_STEP_KEYS: ReadonlySet<string> = new Set([
  "stage",
  "conceptId",
  "cueTemplate",
  "revealsPremiseCheck",
]);
const RUBRIC_RULE_KEYS: ReadonlySet<string> = new Set([
  "ruleId",
  "conceptId",
  "firstErrorRuleId",
  "requiredAstTokens",
  "requiredMissingPremise",
  "positiveAnchors",
  "negativeAnchors",
]);
const RUBRIC_ANCHOR_KEYS: ReadonlySet<string> = new Set([
  "anchorId",
  "label",
  "conceptId",
  "firstErrorRuleId",
  "normalizedAstEdit",
  "establishedPremises",
  "expression",
  "rationale",
]);
const KNOWN_PATCH_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  ...ALLOWED_GEPA_MUTATION_SURFACES,
  ...PATCH_TOP_LEVEL_KEYS,
  ...MOVE_RULE_KEYS,
  ...HINT_STEP_KEYS,
  ...RUBRIC_RULE_KEYS,
  ...RUBRIC_ANCHOR_KEYS,
]);
const MAX_SLOT_KEY_LENGTH = 256;
const MAX_PATCH_STRING_LENGTH = 4096;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkPrototypePollutionKeys(
  obj: Record<string, unknown>,
  path: string,
  issues: string[],
): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      issues.push(`${path}:forbidden_prototype_key(${key})`);
    }
  }
}

function checkStrictPlainObjectOwnProperties(
  obj: Record<string, unknown>,
  path: string,
  issues: string[],
): void {
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    issues.push(`${path}:forbidden_symbol_key`);
  }
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) continue;
    if (desc.get || desc.set) {
      issues.push(`${path}:forbidden_accessor_property`);
    } else if (!desc.enumerable) {
      issues.push(`${path}:forbidden_non_enumerable_property`);
    }
  }
}

function checkOnlyDeclaredKeys(
  obj: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    if (!allowedKeys.has(key)) {
      // Never echo raw unknown caller keys into error messages or issue lists.
      issues.push(`${path}.[unexpected_key]:unexpected_patch_field`);
    }
  }
}

function checkNonEmptyStringField(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  maxLength: number = MAX_PATCH_STRING_LENGTH,
): void {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc || !desc.enumerable || desc.get || desc.set) {
    issues.push(`${path}.${key}:must_be_nonempty_string(max=${maxLength})`);
    return;
  }
  const val = desc.value;
  if (typeof val !== "string" || val.trim().length === 0 || val.length > maxLength) {
    issues.push(`${path}.${key}:must_be_nonempty_string(max=${maxLength})`);
  }
}

function validateRubricAnchorExampleShape(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    issues.push(`${path}:must_be_plain_object`);
    return;
  }
  checkPrototypePollutionKeys(value, path, issues);
  checkStrictPlainObjectOwnProperties(value, path, issues);
  checkOnlyDeclaredKeys(value, RUBRIC_ANCHOR_KEYS, path, issues);
  checkNonEmptyStringField(value, "anchorId", path, issues);
  if (value.label !== "positive" && value.label !== "negative") {
    issues.push(`${path}.label:must_be_positive_or_negative`);
  }
  checkNonEmptyStringField(value, "conceptId", path, issues);
  checkNonEmptyStringField(value, "firstErrorRuleId", path, issues);
  checkNonEmptyStringField(value, "normalizedAstEdit", path, issues);
  checkNonEmptyStringField(value, "expression", path, issues);
  checkNonEmptyStringField(value, "rationale", path, issues);
  if (!Array.isArray(value.establishedPremises)) {
    issues.push(`${path}.establishedPremises:must_be_string_array`);
  } else {
    let validPremises = true;
    for (let pIdx = 0; pIdx < value.establishedPremises.length; pIdx += 1) {
      if (!Object.prototype.hasOwnProperty.call(value.establishedPremises, pIdx)) {
        issues.push(`${path}.establishedPremises[${pIdx}]:sparse_array_hole`);
        validPremises = false;
        continue;
      }
      const p = value.establishedPremises[pIdx];
      if (typeof p !== "string" || p.length > MAX_PATCH_STRING_LENGTH) {
        validPremises = false;
      }
    }
    if (!validPremises) {
      issues.push(`${path}.establishedPremises:must_be_string_array`);
    }
  }
}

function validateSurfacePayloadSchema(surface: string, payload: unknown): void {
  const issues: string[] = [];

  switch (surface) {
    case "moveRules": {
      if (!Array.isArray(payload)) {
        issues.push("moveRules.payload:must_be_array");
        break;
      }
      for (let index = 0; index < payload.length; index += 1) {
        const path = `moveRules[${index}]`;
        if (!Object.prototype.hasOwnProperty.call(payload, index)) {
          issues.push(`${path}:sparse_array_hole`);
          continue;
        }
        const item = payload[index];
        if (!isPlainObject(item)) {
          issues.push(`${path}:must_be_plain_object`);
          continue;
        }
        checkPrototypePollutionKeys(item, path, issues);
        checkStrictPlainObjectOwnProperties(item, path, issues);
        checkOnlyDeclaredKeys(item, MOVE_RULE_KEYS, path, issues);
        checkNonEmptyStringField(item, "id", path, issues);
        checkNonEmptyStringField(item, "conceptId", path, issues);
        checkNonEmptyStringField(item, "triggerRuleId", path, issues);
        checkNonEmptyStringField(item, "missingPremise", path, issues);
        checkNonEmptyStringField(item, "move", path, issues);
        if (typeof item.priority !== "number" || !Number.isFinite(item.priority)) {
          issues.push(`${path}.priority:must_be_finite_number`);
        }
      }
      break;
    }

    case "hintLadder": {
      if (!Array.isArray(payload)) {
        issues.push("hintLadder.payload:must_be_array");
        break;
      }
      for (let index = 0; index < payload.length; index += 1) {
        const path = `hintLadder[${index}]`;
        if (!Object.prototype.hasOwnProperty.call(payload, index)) {
          issues.push(`${path}:sparse_array_hole`);
          continue;
        }
        const item = payload[index];
        if (!isPlainObject(item)) {
          issues.push(`${path}:must_be_plain_object`);
          continue;
        }
        checkPrototypePollutionKeys(item, path, issues);
        checkStrictPlainObjectOwnProperties(item, path, issues);
        checkOnlyDeclaredKeys(item, HINT_STEP_KEYS, path, issues);
        if (
          typeof item.stage !== "number" ||
          !Number.isFinite(item.stage) ||
          !Number.isInteger(item.stage) ||
          item.stage < 0
        ) {
          issues.push(`${path}.stage:must_be_nonnegative_integer`);
        }
        checkNonEmptyStringField(item, "conceptId", path, issues);
        checkNonEmptyStringField(item, "cueTemplate", path, issues);
        if (typeof item.revealsPremiseCheck !== "boolean") {
          issues.push(`${path}.revealsPremiseCheck:must_be_boolean`);
        }
      }
      break;
    }

    case "rubricAnchors": {
      if (!Array.isArray(payload)) {
        issues.push("rubricAnchors.payload:must_be_array");
        break;
      }
      for (let index = 0; index < payload.length; index += 1) {
        const path = `rubricAnchors[${index}]`;
        if (!Object.prototype.hasOwnProperty.call(payload, index)) {
          issues.push(`${path}:sparse_array_hole`);
          continue;
        }
        const item = payload[index];
        if (!isPlainObject(item)) {
          issues.push(`${path}:must_be_plain_object`);
          continue;
        }
        checkPrototypePollutionKeys(item, path, issues);
        checkStrictPlainObjectOwnProperties(item, path, issues);
        checkOnlyDeclaredKeys(item, RUBRIC_RULE_KEYS, path, issues);
        checkNonEmptyStringField(item, "ruleId", path, issues);
        checkNonEmptyStringField(item, "conceptId", path, issues);
        checkNonEmptyStringField(item, "firstErrorRuleId", path, issues);
        checkNonEmptyStringField(item, "requiredMissingPremise", path, issues);
        if (!Array.isArray(item.requiredAstTokens)) {
          issues.push(`${path}.requiredAstTokens:must_be_nonempty_string_array`);
        } else {
          let validAstTokens = true;
          for (let tIdx = 0; tIdx < item.requiredAstTokens.length; tIdx += 1) {
            if (!Object.prototype.hasOwnProperty.call(item.requiredAstTokens, tIdx)) {
              issues.push(`${path}.requiredAstTokens[${tIdx}]:sparse_array_hole`);
              validAstTokens = false;
              continue;
            }
            const t = item.requiredAstTokens[tIdx];
            if (typeof t !== "string" || t.trim().length === 0 || t.length > MAX_PATCH_STRING_LENGTH) {
              validAstTokens = false;
            }
          }
          if (!validAstTokens) {
            issues.push(`${path}.requiredAstTokens:must_be_nonempty_string_array`);
          }
        }
        if (!Array.isArray(item.positiveAnchors)) {
          issues.push(`${path}.positiveAnchors:must_be_array`);
        } else {
          for (let aIdx = 0; aIdx < item.positiveAnchors.length; aIdx += 1) {
            if (!Object.prototype.hasOwnProperty.call(item.positiveAnchors, aIdx)) {
              issues.push(`${path}.positiveAnchors[${aIdx}]:sparse_array_hole`);
              continue;
            }
            validateRubricAnchorExampleShape(
              item.positiveAnchors[aIdx],
              `${path}.positiveAnchors[${aIdx}]`,
              issues,
            );
          }
        }
        if (!Array.isArray(item.negativeAnchors)) {
          issues.push(`${path}.negativeAnchors:must_be_array`);
        } else {
          for (let aIdx = 0; aIdx < item.negativeAnchors.length; aIdx += 1) {
            if (!Object.prototype.hasOwnProperty.call(item.negativeAnchors, aIdx)) {
              issues.push(`${path}.negativeAnchors[${aIdx}]:sparse_array_hole`);
              continue;
            }
            validateRubricAnchorExampleShape(
              item.negativeAnchors[aIdx],
              `${path}.negativeAnchors[${aIdx}]`,
              issues,
            );
          }
        }
      }
      break;
    }

    case "approvedTemplateSlots": {
      if (!isPlainObject(payload)) {
        issues.push("approvedTemplateSlots.payload:must_be_plain_object");
        break;
      }
      checkPrototypePollutionKeys(payload, "approvedTemplateSlots", issues);
      checkStrictPlainObjectOwnProperties(payload, "approvedTemplateSlots", issues);
      for (const key of Object.getOwnPropertyNames(payload)) {
        if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
        const desc = Object.getOwnPropertyDescriptor(payload, key);
        if (!desc || !desc.enumerable || desc.get || desc.set) continue;
        if (key.trim().length === 0 || key.length > MAX_SLOT_KEY_LENGTH) {
          issues.push("approvedTemplateSlots.[unexpected_key]:invalid_slot_key");
        }
        const val = desc.value;
        if (typeof val !== "string" || val.length > MAX_PATCH_STRING_LENGTH) {
          issues.push("approvedTemplateSlots.[unexpected_key]:value_must_be_finite_string");
        }
      }
      break;
    }
  }

  if (issues.length > 0) {
    throw new GepaInvalidPatchPayloadError(
      `Invalid GEPA patch payload for surface "${surface}": ${issues.join("; ")}`,
      surface,
      issues,
    );
  }
}

export interface DisjointSplitOptions {
  readonly seed?: number;
  /** Target fraction of trajectories/entities reserved for holdout (default 0.25). */
  readonly holdoutRatio?: number;
  /** Target fraction of remaining train+dev trajectories reserved for dev (default 0.25). */
  readonly devRatio?: number;
}

/**
 * Verifies raw-PII / pseudonymization invariants FIRST, then strict canonicalized
 * `(learnerPseudoId, itemFamilyId)` disjointness between `holdout` and `train`/`dev`.
 * Throws `CartridgePiiViolationError` before any `HoldoutFirewallError` so raw PII IDs
 * can never echo into holdout overlap error messages or fields.
 */
export function assertDisjointSplitInvariants(split: DisjointDatasetSplit): void {
  // Defense-in-depth: scan the entire split and enforce pseudonymized trajectory invariants FIRST
  // so raw PII learner/trajectory IDs are quarantined before any overlap error is constructed.
  assertNoRawPiiInValue(split, "disjoint_split");
  for (const record of [
    ...split.holdout,
    ...split.train,
    ...split.dev,
    ...(split.quarantinedCrossing ?? []),
  ]) {
    assertPseudonymizedTrajectory(record);
  }
  if (split.holdoutFirewall) {
    for (const id of split.holdoutFirewall.holdoutTrajectoryIds) {
      assertNoRawPiiInText(canonicalizeIdentifier(id, "holdoutTrajectoryId"), "holdoutTrajectoryId");
    }
    for (const id of split.holdoutFirewall.holdoutLearnerPseudoIds) {
      assertNoRawPiiInText(
        canonicalizeIdentifier(id, "holdoutLearnerPseudoId"),
        "holdoutLearnerPseudoId",
      );
    }
    for (const id of split.holdoutFirewall.holdoutItemFamilyIds) {
      assertNoRawPiiInText(canonicalizeIdentifier(id, "holdoutItemFamilyId"), "holdoutItemFamilyId");
    }
  }

  const holdoutTrajIds = new Set(
    split.holdout.map((t) => canonicalizeIdentifier(t.trajectoryId, "trajectoryId")),
  );
  const holdoutLearners = new Set(
    split.holdout.map((t) =>
      canonicalizeIdentifier(t.learnerPseudoId, "learnerPseudoId", t.trajectoryId),
    ),
  );
  const holdoutFamilies = new Set(
    split.holdout.map((t) =>
      canonicalizeIdentifier(t.itemFamilyId, "itemFamilyId", t.trajectoryId),
    ),
  );

  const leakedTrajectoryIds: string[] = [];
  const leakedLearners = new Set<string>();
  const leakedFamilies = new Set<string>();

  for (const record of [...split.train, ...split.dev]) {
    const trajId = canonicalizeIdentifier(record.trajectoryId, "trajectoryId");
    const learnerId = canonicalizeIdentifier(record.learnerPseudoId, "learnerPseudoId", trajId);
    const familyId = canonicalizeIdentifier(record.itemFamilyId, "itemFamilyId", trajId);

    let violated = false;
    if (holdoutTrajIds.has(trajId)) {
      violated = true;
    }
    if (holdoutLearners.has(learnerId)) {
      leakedLearners.add(learnerId);
      violated = true;
    }
    if (holdoutFamilies.has(familyId)) {
      leakedFamilies.add(familyId);
      violated = true;
    }
    if (violated) {
      leakedTrajectoryIds.push(trajId);
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
 * Partitions trajectories into `train`, `dev`, and `holdout` after NFKC+trim
 * canonicalization such that NO `learnerPseudoId` AND NO `itemFamilyId` appearing
 * in `holdout` ever appears in `train` or `dev`.
 */
export function createDisjointTrajectorySplit(
  trajectories: readonly ErrorTrajectoryRecord[],
  options: DisjointSplitOptions = {},
): DisjointDatasetSplit {
  assertNoRawPiiInValue(options, "disjoint_split_options");
  assertNoRawPiiInValue(trajectories, "disjoint_split_trajectories");
  const canonical: ErrorTrajectoryRecord[] = [];
  for (let i = 0; i < trajectories.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(trajectories, i)) {
      throw new GepaInvalidPatchPayloadError(
        `Trajectory list contains sparse array hole at index ${i}`,
        "disjointSplit",
        [`trajectories[${i}]:sparse_array_hole`],
      );
    }
    canonical.push(canonicalizeTrajectoryRecord(trajectories[i]!));
  }

  const seed = options.seed ?? 20261121;
  const holdoutRatio = Math.min(0.5, Math.max(0.1, options.holdoutRatio ?? 0.25));
  const devRatio = Math.min(0.5, Math.max(0.1, options.devRatio ?? 0.25));

  if (canonical.length === 0) {
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

  // Union-Find over canonical bipartite nodes ("L:<id>" and "F:<id>")
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

  for (const t of canonical) {
    union(`L:${t.learnerPseudoId}`, `F:${t.itemFamilyId}`);
  }

  const componentsMap = new Map<string, ErrorTrajectoryRecord[]>();
  for (const t of canonical) {
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
    const targetHoldoutCount = Math.max(1, Math.round(canonical.length * holdoutRatio));
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
    const uniqueLearners = sortedBySeedHash(
      [...new Set(canonical.map((t) => t.learnerPseudoId))],
      seed,
      "learner",
    );
    const uniqueFamilies = sortedBySeedHash(
      [...new Set(canonical.map((t) => t.itemFamilyId))],
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

      let candidateHoldout = canonical.filter(
        (t) => holdoutLearnerSet.has(t.learnerPseudoId) && holdoutFamilySet.has(t.itemFamilyId),
      );
      if (candidateHoldout.length === 0) {
        const anchor = canonical[0]!;
        holdoutLearnerSet.clear();
        holdoutFamilySet.clear();
        holdoutLearnerSet.add(anchor.learnerPseudoId);
        holdoutFamilySet.add(anchor.itemFamilyId);
        candidateHoldout = canonical.filter(
          (t) => holdoutLearnerSet.has(t.learnerPseudoId) && holdoutFamilySet.has(t.itemFamilyId),
        );
      }

      holdout = candidateHoldout;
      trainDevPool = canonical.filter(
        (t) => !holdoutLearnerSet.has(t.learnerPseudoId) && !holdoutFamilySet.has(t.itemFamilyId),
      );
      quarantinedCrossing = canonical.filter(
        (t) =>
          (holdoutLearnerSet.has(t.learnerPseudoId) && !holdoutFamilySet.has(t.itemFamilyId)) ||
          (!holdoutLearnerSet.has(t.learnerPseudoId) && holdoutFamilySet.has(t.itemFamilyId)),
      );
    } else {
      trainDevPool = [...canonical];
    }
  }

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
 * Enforces the GEPA Holdout Firewall after NFKC+trim canonicalization: throws a
 * deterministic `HoldoutFirewallError` if ANY trajectory shares a canonical
 * `trajectoryId`, `learnerPseudoId`, or `itemFamilyId` with `holdout`.
 */
export function assertNoHoldoutLeakage(
  trajectories: readonly ErrorTrajectoryRecord[],
  firewall: HoldoutFirewall,
): void {
  // Run raw PII checks on BOTH firewall and incoming trajectories FIRST before overlap reporting.
  assertNoRawPiiInValue(firewall, "holdout_firewall");
  assertNoRawPiiInValue(trajectories, "firewall_trajectories");

  const blockedTrajectoryIds = new Set(
    firewall.holdoutTrajectoryIds.map((id) => {
      const canonical = canonicalizeIdentifier(id, "holdoutTrajectoryId");
      assertNoRawPiiInText(canonical, "holdoutTrajectoryId");
      return canonical;
    }),
  );
  const blockedLearners = new Set(
    firewall.holdoutLearnerPseudoIds.map((id) => {
      const canonical = canonicalizeIdentifier(id, "holdoutLearnerPseudoId");
      assertNoRawPiiInText(canonical, "holdoutLearnerPseudoId");
      return canonical;
    }),
  );
  const blockedFamilies = new Set(
    firewall.holdoutItemFamilyIds.map((id) => {
      const canonical = canonicalizeIdentifier(id, "holdoutItemFamilyId");
      assertNoRawPiiInText(canonical, "holdoutItemFamilyId");
      return canonical;
    }),
  );

  const leakedTrajectoryIds: string[] = [];
  const leakedLearners = new Set<string>();
  const leakedFamilies = new Set<string>();

  for (const raw of trajectories) {
    const t = canonicalizeTrajectoryRecord(raw);
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
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || desc.get || desc.set) continue;
      const hit = scanObjectForForbiddenSurfaceKeys(desc.value, `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const sym of Object.getOwnPropertySymbols(value)) {
    const symDesc = typeof sym.description === "string" ? sym.description.toLowerCase() : "";
    if (FORBIDDEN_SURFACE_SET.has(symDesc)) {
      return `${pathPrefix}.<symbol_key>`;
    }
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_SURFACE_SET.has(key.toLowerCase())) {
      return `${pathPrefix}.${key}`;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || desc.get || desc.set) continue;
    // Never interpolate unrecognized/caller-supplied ancestor keys into error paths or attemptedSurface.
    const safeSegment = KNOWN_PATCH_SCHEMA_KEYS.has(key) ? key : "<unexpected_key>";
    const hit = scanObjectForForbiddenSurfaceKeys(desc.value, `${pathPrefix}.${safeSegment}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Validates that a GEPA mutation patch:
 * 1) targets ONLY an allowed declarative surface (`moveRules`, `hintLadder`,
 *    `rubricAnchors`, `approvedTemplateSlots`), never touching `permissions`,
 *    `answerVisibility`, `gradingWriteAuthority`, or `leakageDetectors`,
 * 2) conforms strictly to the runtime schema of that surface (no prototype
 *    pollution keys, no symbol/accessor/non-enumerable own properties, no malformed containers), and
 * 3) contains zero raw PII across `summary` and every nested leaf.
 */
export function assertAllowedGepaPatch(patch: unknown): asserts patch is GepaSurfacePatch {
  // Run PII scan FIRST before any surface/schema check so raw PII in unexpected keys or
  // malformed fields is quarantined without ever echoing unrecognized ancestor keys.
  assertNoRawPiiInValue(patch, "gepa_patch", undefined, {
    allowedDiagnosticKeys: KNOWN_PATCH_SCHEMA_KEYS,
  });

  if (!isPlainObject(patch)) {
    throw new GepaForbiddenSurfaceError("GEPA patch must be a plain non-null object", "invalid");
  }
  const topProtoIssues: string[] = [];
  checkPrototypePollutionKeys(patch, "patch", topProtoIssues);
  checkStrictPlainObjectOwnProperties(patch, "patch", topProtoIssues);
  if (topProtoIssues.length > 0) {
    throw new GepaInvalidPatchPayloadError(
      `GEPA patch contains forbidden own property or prototype key: ${topProtoIssues.join(", ")}`,
      "invalid",
      topProtoIssues,
    );
  }

  const surface = patch.surface;
  if (typeof surface !== "string" || !ALLOWED_SURFACE_SET.has(surface)) {
    const safeSurfaceLabel =
      typeof surface === "string" && FORBIDDEN_SURFACE_SET.has(surface.toLowerCase())
        ? surface
        : "[unknown_surface]";
    throw new GepaForbiddenSurfaceError(
      `GEPA patch attempted to mutate forbidden or unknown surface "${safeSurfaceLabel}". Allowed surfaces: ${ALLOWED_GEPA_MUTATION_SURFACES.join(", ")}`,
      safeSurfaceLabel,
    );
  }

  for (const key of Object.getOwnPropertyNames(patch)) {
    if (FORBIDDEN_SURFACE_SET.has(key.toLowerCase())) {
      throw new GepaForbiddenSurfaceError(
        `GEPA patch contains forbidden authority key "${key}"`,
        key,
      );
    }
  }

  const nestedHit = scanObjectForForbiddenSurfaceKeys(patch.payload, surface);
  if (nestedHit) {
    throw new GepaForbiddenSurfaceError(
      `GEPA patch payload attempted to smuggle forbidden authority surface at "${nestedHit}"`,
      nestedHit,
    );
  }

  const topDeclaredIssues: string[] = [];
  checkOnlyDeclaredKeys(patch, PATCH_TOP_LEVEL_KEYS, "patch", topDeclaredIssues);
  if (topDeclaredIssues.length > 0) {
    throw new GepaInvalidPatchPayloadError(
      `GEPA patch contains unexpected top-level keys: ${topDeclaredIssues.join(", ")}`,
      surface,
      topDeclaredIssues,
    );
  }

  if (
    typeof patch.summary !== "string" ||
    patch.summary.trim().length === 0 ||
    patch.summary.length > MAX_PATCH_STRING_LENGTH
  ) {
    throw new GepaInvalidPatchPayloadError(
      `GEPA patch summary must be a non-empty finite string (max ${MAX_PATCH_STRING_LENGTH})`,
      surface,
      ["patch.summary:must_be_nonempty_string"],
    );
  }

  validateSurfacePayloadSchema(surface, patch.payload);
  // Post-normalization PII scan on rubric anchor expressions/AST tokens/premises.
  if (surface === "rubricAnchors") {
    const rules = patch.payload as readonly MisconceptionRubricRule[];
    for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx += 1) {
      const rule = rules[ruleIdx]!;
      assertNoRawPiiInText(
        normalizeAstEdit(rule.requiredAstTokens.join("|")),
        `gepa_patch:rubricAnchors[${ruleIdx}].requiredAstTokens(post_norm)`,
      );
      const anchors = [...rule.positiveAnchors, ...rule.negativeAnchors];
      for (let anchorIdx = 0; anchorIdx < anchors.length; anchorIdx += 1) {
        const anchor = anchors[anchorIdx]!;
        assertNoRawPiiInText(
          normalizeAstEdit(anchor.normalizedAstEdit),
          `gepa_patch:rubricAnchors[${ruleIdx}].anchor[${anchorIdx}](post_norm)`,
        );
      }
    }
  }
}

function cloneMoveRule(rule: CartridgeMoveRule): CartridgeMoveRule {
  return {
    id: rule.id,
    conceptId: rule.conceptId,
    triggerRuleId: rule.triggerRuleId,
    missingPremise: rule.missingPremise,
    move: rule.move,
    priority: rule.priority,
  };
}

function cloneHintStep(step: CartridgeHintStep): CartridgeHintStep {
  return {
    stage: step.stage,
    conceptId: step.conceptId,
    cueTemplate: step.cueTemplate,
    revealsPremiseCheck: step.revealsPremiseCheck,
  };
}

function cloneRubricRule(rule: MisconceptionRubricRule): MisconceptionRubricRule {
  return {
    ruleId: rule.ruleId,
    conceptId: rule.conceptId,
    firstErrorRuleId: rule.firstErrorRuleId,
    requiredAstTokens: [...rule.requiredAstTokens],
    requiredMissingPremise: rule.requiredMissingPremise,
    positiveAnchors: rule.positiveAnchors.map((a) => ({
      anchorId: a.anchorId,
      label: a.label,
      conceptId: a.conceptId,
      firstErrorRuleId: a.firstErrorRuleId,
      normalizedAstEdit: a.normalizedAstEdit,
      establishedPremises: [...a.establishedPremises],
      expression: a.expression,
      rationale: a.rationale,
    })),
    negativeAnchors: rule.negativeAnchors.map((a) => ({
      anchorId: a.anchorId,
      label: a.label,
      conceptId: a.conceptId,
      firstErrorRuleId: a.firstErrorRuleId,
      normalizedAstEdit: a.normalizedAstEdit,
      establishedPremises: [...a.establishedPremises],
      expression: a.expression,
      rationale: a.rationale,
    })),
  };
}

function bumpPolicyVersion(version: string, suffix: string): string {
  return `${version}+${suffix}`;
}

/**
 * Applies a validated declarative patch to a cartridge policy, returning a new
 * immutable policy reconstructed strictly from validated declared fields.
 * Rejects forbidden surfaces, undeclared/malformed payload shapes, raw PII in
 * patch strings, and invalid rubric anchor pairs.
 */
export function validateAndApplyGepaPatch(
  policy: CartridgeDeclarativePolicy,
  patch: unknown,
  versionTag = "gepa",
): CartridgeDeclarativePolicy {
  assertNoRawPiiInValue(policy, "gepa_base_policy");
  assertAllowedGepaPatch(patch);

  switch (patch.surface) {
    case "moveRules": {
      const merged = new Map<string, CartridgeMoveRule>(
        policy.moveRules.map((r) => [r.id, cloneMoveRule(r)]),
      );
      for (const rule of patch.payload) {
        merged.set(rule.id, cloneMoveRule(rule));
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
        policy.hintLadder.map((h) => [`${h.conceptId}::${h.stage}`, cloneHintStep(h)]),
      );
      for (const step of patch.payload) {
        merged.set(`${step.conceptId}::${step.stage}`, cloneHintStep(step));
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
      const sanitizedRules = patch.payload.map((rule) => cloneRubricRule(rule));
      for (const rule of sanitizedRules) {
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
        policy.rubricAnchors.map((r) => [r.ruleId, cloneRubricRule(r)]),
      );
      for (const rule of sanitizedRules) {
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
      const slotIssues: string[] = [];
      if (!isPlainObject(policy.approvedTemplateSlots)) {
        slotIssues.push("basePolicy.approvedTemplateSlots:must_be_plain_object");
      } else {
        checkPrototypePollutionKeys(
          policy.approvedTemplateSlots,
          "basePolicy.approvedTemplateSlots",
          slotIssues,
        );
        checkStrictPlainObjectOwnProperties(
          policy.approvedTemplateSlots,
          "basePolicy.approvedTemplateSlots",
          slotIssues,
        );
      }
      if (!isPlainObject(patch.payload)) {
        slotIssues.push("approvedTemplateSlots.payload:must_be_plain_object");
      } else {
        checkPrototypePollutionKeys(patch.payload, "approvedTemplateSlots", slotIssues);
        checkStrictPlainObjectOwnProperties(patch.payload, "approvedTemplateSlots", slotIssues);
      }
      if (slotIssues.length > 0) {
        throw new GepaInvalidPatchPayloadError(
          `Invalid approvedTemplateSlots container: ${slotIssues.join("; ")}`,
          "approvedTemplateSlots",
          slotIssues,
        );
      }

      const nextSlots: Record<string, string> = {};
      for (const k of Object.keys(policy.approvedTemplateSlots)) {
        if (!PROTOTYPE_POLLUTION_KEYS.has(k)) {
          const desc = Object.getOwnPropertyDescriptor(policy.approvedTemplateSlots, k);
          if (desc && desc.enumerable && !desc.get && !desc.set && typeof desc.value === "string") {
            nextSlots[k] = desc.value;
          }
        }
      }
      for (const k of Object.keys(patch.payload)) {
        if (!PROTOTYPE_POLLUTION_KEYS.has(k)) {
          const desc = Object.getOwnPropertyDescriptor(patch.payload, k);
          if (desc && desc.enumerable && !desc.get && !desc.set && typeof desc.value === "string") {
            nextSlots[k] = desc.value;
          }
        }
      }
      return {
        ...policy,
        version: bumpPolicyVersion(policy.version, versionTag),
        approvedTemplateSlots: nextSlots,
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
 * Enforces PII scanning, canonicalization, and holdout firewall on BOTH train and dev trajectories.
 */
export function buildGepaReflectionContext(
  input: BuildGepaReflectionInput,
): GepaReflectionContext {
  // Scan ALL reflection inputs FIRST before dot-accessing or spreading any properties so getters never run.
  assertNoRawPiiInValue(input.policy, "reflection_base_policy");
  assertNoRawPiiInValue(input.holdoutFirewall, "reflection_holdout_firewall");
  assertNoRawPiiInValue(input.trainTrajectories, "reflection_train_trajectories");
  assertNoRawPiiInValue(input.devTrajectories, "reflection_dev_trajectories");
  if (input.clusteringOptions !== undefined) {
    assertNoRawPiiInValue(input.clusteringOptions, "reflection_clustering_options");
  }

  const canonicalPolicyId = canonicalizeIdentifier(input.policy.policyId, "policyId");
  assertNoRawPiiInText(canonicalPolicyId, "reflection_base_policy.policyId");
  const sanitizedPolicy: CartridgeDeclarativePolicy = {
    ...input.policy,
    policyId: canonicalPolicyId,
  };
  assertNoHoldoutLeakage(input.trainTrajectories, input.holdoutFirewall);
  assertNoHoldoutLeakage(input.devTrajectories, input.holdoutFirewall);

  const summary = clusterErrorTrajectories(input.trainTrajectories, input.clusteringOptions);
  const context: GepaReflectionContext = {
    policyId: sanitizedPolicy.policyId,
    policyVersion: sanitizedPolicy.version,
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
    currentPolicy: sanitizedPolicy,
  };
  assertNoRawPiiInValue(context, "gepa_reflection_output");
  return context;
}

/**
 * Deterministically proposes candidate declarative patches over allowed GEPA
 * surfaces (`moveRules`, `hintLadder`, `rubricAnchors`, `approvedTemplateSlots`)
 * derived strictly from actionable clusters in the sanitized reflection context,
 * verifying every generated patch through PII, schema, surface, and anchor guards.
 */
export function proposeGepaReflectivePatches(
  context: GepaReflectionContext,
): readonly GepaProposedCandidate[] {
  assertNoRawPiiInValue(context, "gepa_reflection_context");
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

    const candidateId = canonicalizeIdentifier(
      `${basePolicy.policyId}__gepa_${suffix}`,
      "candidateId",
    );
    assertNoRawPiiInText(candidateId, "gepa_proposed_candidate.candidateId");

    candidates.push({
      candidateId,
      policy: {
        ...mutated,
        policyId: candidateId,
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
  // Scan ALL static inputs for raw PII strictly BEFORE disjoint-split / holdout / ID checks
  // so raw PII learner IDs, boxed primitives, or fields can never echo into HoldoutFirewallError or RangeError.
  assertNoRawPiiInValue(input.split, "gepa_round.split");
  assertNoRawPiiInValue(input.basePolicy, "gepa_round.basePolicy");
  assertNoRawPiiInValue(input.paretoOptions, "gepa_round.paretoOptions");
  if (input.clusteringOptions !== undefined) {
    assertNoRawPiiInValue(input.clusteringOptions, "gepa_round.clusteringOptions");
  }
  if (input.extraCandidatePatches !== undefined) {
    assertNoRawPiiInValue(input.extraCandidatePatches, "gepa_round.extraCandidatePatches");
  }
  assertDisjointSplitInvariants(input.split);

  const reflectionContext = buildGepaReflectionContext({
    policy: input.basePolicy,
    trainTrajectories: input.split.train,
    devTrajectories: input.split.dev,
    holdoutFirewall: input.split.holdoutFirewall,
    clusteringOptions: input.clusteringOptions,
  });

  const seenCandidateIds = new Set<string>();
  const proposed: GepaProposedCandidate[] = [];

  for (const generated of proposeGepaReflectivePatches(reflectionContext)) {
    const canonicalId = canonicalizeIdentifier(generated.candidateId, "candidateId");
    assertNoRawPiiInText(canonicalId, "generated_candidate.candidateId");
    if (seenCandidateIds.has(canonicalId)) {
      throw new CandidateIdentityError(
        `Duplicate generated candidateId "${canonicalId}" in GEPA optimization round.`,
        "duplicate_candidate_id",
        canonicalId,
      );
    }
    seenCandidateIds.add(canonicalId);
    proposed.push(generated);
  }

  for (const extra of input.extraCandidatePatches ?? []) {
    assertNoRawPiiInValue(extra, "extra_candidate");
    const canonicalExtraId = canonicalizeIdentifier(extra.candidateId, "candidateId");
    assertNoRawPiiInText(canonicalExtraId, "extra_candidate.candidateId");
    if (seenCandidateIds.has(canonicalExtraId)) {
      throw new CandidateIdentityError(
        `Duplicate candidateId "${canonicalExtraId}" in GEPA optimization round.`,
        "duplicate_candidate_id",
        canonicalExtraId,
      );
    }
    seenCandidateIds.add(canonicalExtraId);

    let policy = reflectionContext.currentPolicy;
    const applied: GepaSurfacePatch[] = [];
    for (let i = 0; i < extra.patches.length; i += 1) {
      const rawPatch = extra.patches[i];
      policy = validateAndApplyGepaPatch(policy, rawPatch, `ext_${i + 1}`);
      applied.push(rawPatch as GepaSurfacePatch);
    }
    proposed.push({
      candidateId: canonicalExtraId,
      policy: { ...policy, policyId: canonicalExtraId },
      appliedPatches: applied,
    });
  }

  const rawReceipts: unknown[] = proposed.map((candidate) => input.scoreCandidate(candidate));

  // Scan ALL raw scorer receipts for PII FIRST before any CandidateIdentityError can fire.
  for (let i = 0; i < proposed.length; i += 1) {
    assertNoRawPiiInValue(rawReceipts[i], `scorer_receipt[${proposed[i]!.candidateId}]`);
  }

  // Pre-collect all candidateIds across proposed candidates, baseline, and raw receipts so any
  // synthetic malformed-receipt ID can never collide with a valid caller candidateId.
  const reservedIds = new Set<string>();
  const rawBaseline = input.paretoOptions.baseline as unknown;
  if (isPlainObject(rawBaseline) && typeof rawBaseline.candidateId === "string") {
    reservedIds.add(rawBaseline.candidateId);
    const trimmedBase = rawBaseline.candidateId.normalize("NFKC").trim();
    if (trimmedBase.length > 0) reservedIds.add(trimmedBase);
  }
  for (const candidate of proposed) {
    reservedIds.add(candidate.candidateId);
  }
  for (const rawReceipt of rawReceipts) {
    if (isPlainObject(rawReceipt) && typeof rawReceipt.candidateId === "string") {
      reservedIds.add(rawReceipt.candidateId);
      const trimmedReceiptId = rawReceipt.candidateId.normalize("NFKC").trim();
      if (trimmedReceiptId.length > 0) reservedIds.add(trimmedReceiptId);
    }
  }
  const allocateSyntheticMalformedId = (idx: number): string => {
    let synthId = `__malformed_receipt_${idx}`;
    while (reservedIds.has(synthId)) {
      synthId += "_x";
    }
    reservedIds.add(synthId);
    return synthId;
  };

  const candidateMetrics: CartridgeCandidateMetrics[] = proposed.map((candidate, idx) => {
    const rawReceipt = rawReceipts[idx];

    const makeMalformedVetoReceipt = (): CartridgeCandidateMetrics => {
      const targetId =
        typeof candidate.candidateId === "string" && candidate.candidateId.trim().length > 0
          ? candidate.candidateId
          : allocateSyntheticMalformedId(idx);
      return {
        candidateId: targetId,
        c: {
          rate: Number.NaN,
          repairedCount: Number.NaN,
          verifiableFirstErrorCount: Number.NaN,
          abandonedCount: Number.NaN,
          abandonmentRate: Number.NaN,
        },
        l: {
          rate: Number.NaN,
          leakedReleasedTurns: Number.NaN,
          totalReleasedTurns: Number.NaN,
          severeLeakCount: Number.NaN,
          guardBlockedCount: Number.NaN,
          telemetryIssues: ["missing_scorer_receipt"],
        },
        t7: {
          status: "pending",
          passedFreshTransferCount: 0,
          eligibleFollowupCohortCount: 0,
          pendingCohortCount: 0,
          reason: "redacted_invalid_t7_status",
        },
      };
    };

    // Isolate null / undefined / non-object / missing-ID receipts as vetoed entries so valid siblings proceed.
    if (!isPlainObject(rawReceipt)) {
      return makeMalformedVetoReceipt();
    }
    const rawReceiptId = rawReceipt.candidateId;
    if (typeof rawReceiptId !== "string" || rawReceiptId.normalize("NFKC").trim().length === 0) {
      return makeMalformedVetoReceipt();
    }

    const canonicalReceiptId = canonicalizeIdentifier(rawReceiptId, "receipt.candidateId");
    assertNoRawPiiInText(canonicalReceiptId, "receipt.candidateId");
    if (canonicalReceiptId !== candidate.candidateId) {
      throw new CandidateIdentityError(
        `Scorer receipt candidateId "${canonicalReceiptId}" does not match evaluated candidate "${candidate.candidateId}".`,
        "mismatched_receipt_candidate_id",
        candidate.candidateId,
      );
    }
    const typedReceipt = rawReceipt as unknown as CartridgeCandidateMetrics;
    return canonicalReceiptId === typedReceipt.candidateId
      ? typedReceipt
      : { ...typedReceipt, candidateId: canonicalReceiptId };
  });

  const pareto = evaluateParetoFrontierAndPromotion(candidateMetrics, input.paretoOptions);

  return {
    reflectionContext,
    candidates: proposed,
    pareto,
  };
}
