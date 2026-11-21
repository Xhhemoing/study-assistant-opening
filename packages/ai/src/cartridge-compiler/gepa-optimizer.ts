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
const DISJOINT_SPLIT_ALLOWED_NUMERIC_PATHS: ReadonlySet<string> = new Set([
  "disjoint_split_options.seed",
  "options.seed",
  "splitOptions.seed",
  "seed",
]);
const GEPA_ROUND_ALLOWED_FUNCTION_PATHS: ReadonlySet<string> = new Set([
  "gepa_round.scoreCandidate",
]);

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

function assertTemplateSlotContainer(slots: unknown, path: string): void {
  const issues: string[] = [];
  if (isPlainObject(slots)) {
    checkPrototypePollutionKeys(slots, path, issues);
    checkStrictPlainObjectOwnProperties(slots, path, issues);
  } else {
    issues.push(`${path}:must_be_plain_object`);
  }
  if (issues.length > 0) {
    throw new GepaInvalidPatchPayloadError(
      `Invalid approvedTemplateSlots container: ${issues.join("; ")}`,
      "approvedTemplateSlots",
      issues,
    );
  }
}

function checkStrictPlainArray(arr: readonly unknown[], path: string, issues: string[]): void {
  if (Object.getPrototypeOf(arr) !== Array.prototype) {
    issues.push(`${path}:forbidden_non_plain_array`);
  }
  if (Object.getOwnPropertySymbols(arr).length > 0) {
    issues.push(`${path}:forbidden_symbol_key`);
  }
  const ownNames = Object.getOwnPropertyNames(arr);
  for (let i = 0; i < ownNames.length; i += 1) {
    const key = ownNames[i]!;
    if (key === "length") continue;
    const idx = Number(key);
    const isDenseIndex = Number.isInteger(idx) && idx >= 0 && idx < arr.length && String(idx) === key;
    if (!isDenseIndex) {
      issues.push(`${path}:forbidden_array_property`);
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(arr, key);
    if (!desc) continue;
    if (desc.get || desc.set) {
      issues.push(`${path}[${idx}]:forbidden_accessor_property`);
    } else if (!desc.enumerable) {
      issues.push(`${path}[${idx}]:forbidden_non_enumerable_property`);
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
    checkStrictPlainArray(value.establishedPremises, `${path}.establishedPremises`, issues);
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
      checkStrictPlainArray(payload, "moveRules.payload", issues);
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
      checkStrictPlainArray(payload, "hintLadder.payload", issues);
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
      checkStrictPlainArray(payload, "rubricAnchors.payload", issues);
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
          checkStrictPlainArray(item.requiredAstTokens, `${path}.requiredAstTokens`, issues);
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
          checkStrictPlainArray(item.positiveAnchors, `${path}.positiveAnchors`, issues);
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
          checkStrictPlainArray(item.negativeAnchors, `${path}.negativeAnchors`, issues);
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
  const allSplitBuckets: readonly (readonly ErrorTrajectoryRecord[])[] = [
    split.holdout,
    split.train,
    split.dev,
    split.quarantinedCrossing ?? [],
  ];
  for (let b = 0; b < allSplitBuckets.length; b += 1) {
    const bucket = allSplitBuckets[b]!;
    for (let i = 0; i < bucket.length; i += 1) {
      assertPseudonymizedTrajectory(bucket[i]!);
    }
  }
  if (split.holdoutFirewall) {
    for (let i = 0; i < split.holdoutFirewall.holdoutTrajectoryIds.length; i += 1) {
      assertNoRawPiiInText(
        canonicalizeIdentifier(split.holdoutFirewall.holdoutTrajectoryIds[i]!, "holdoutTrajectoryId"),
        "holdoutTrajectoryId",
      );
    }
    for (let i = 0; i < split.holdoutFirewall.holdoutLearnerPseudoIds.length; i += 1) {
      assertNoRawPiiInText(
        canonicalizeIdentifier(
          split.holdoutFirewall.holdoutLearnerPseudoIds[i]!,
          "holdoutLearnerPseudoId",
        ),
        "holdoutLearnerPseudoId",
      );
    }
    for (let i = 0; i < split.holdoutFirewall.holdoutItemFamilyIds.length; i += 1) {
      assertNoRawPiiInText(
        canonicalizeIdentifier(split.holdoutFirewall.holdoutItemFamilyIds[i]!, "holdoutItemFamilyId"),
        "holdoutItemFamilyId",
      );
    }
  }

  const holdoutTrajIds = new Set<string>();
  const holdoutLearners = new Set<string>();
  const holdoutFamilies = new Set<string>();
  for (let i = 0; i < split.holdout.length; i += 1) {
    const t = split.holdout[i]!;
    holdoutTrajIds.add(canonicalizeIdentifier(t.trajectoryId, "trajectoryId"));
    holdoutLearners.add(canonicalizeIdentifier(t.learnerPseudoId, "learnerPseudoId", t.trajectoryId));
    holdoutFamilies.add(canonicalizeIdentifier(t.itemFamilyId, "itemFamilyId", t.trajectoryId));
  }

  const leakedTrajectoryIds: string[] = [];
  const leakedLearners = new Set<string>();
  const leakedFamilies = new Set<string>();

  const trainAndDevBuckets: readonly (readonly ErrorTrajectoryRecord[])[] = [split.train, split.dev];
  for (let b = 0; b < trainAndDevBuckets.length; b += 1) {
    const bucket = trainAndDevBuckets[b]!;
    for (let i = 0; i < bucket.length; i += 1) {
      const record = bucket[i]!;
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
  assertNoRawPiiInValue(options, "disjoint_split_options", undefined, {
    allowedNumericMetadataPaths: DISJOINT_SPLIT_ALLOWED_NUMERIC_PATHS,
  });
  assertNoRawPiiInValue(trajectories, "disjoint_split_trajectories");
  if (
    options.seed !== undefined &&
    (typeof options.seed !== "number" || !Number.isFinite(options.seed))
  ) {
    throw new RangeError(
      `disjointSplit options.seed must be a finite number (received invalid ${typeof options.seed}).`,
    );
  }
  if (
    options.holdoutRatio !== undefined &&
    (typeof options.holdoutRatio !== "number" || !Number.isFinite(options.holdoutRatio))
  ) {
    throw new RangeError(
      `disjointSplit options.holdoutRatio must be a finite number (received invalid ${typeof options.holdoutRatio}).`,
    );
  }
  if (
    options.devRatio !== undefined &&
    (typeof options.devRatio !== "number" || !Number.isFinite(options.devRatio))
  ) {
    throw new RangeError(
      `disjointSplit options.devRatio must be a finite number (received invalid ${typeof options.devRatio}).`,
    );
  }

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

  const blockedTrajectoryIds = new Set<string>();
  for (let i = 0; i < firewall.holdoutTrajectoryIds.length; i += 1) {
    const canonical = canonicalizeIdentifier(
      firewall.holdoutTrajectoryIds[i]!,
      "holdoutTrajectoryId",
    );
    assertNoRawPiiInText(canonical, "holdoutTrajectoryId");
    blockedTrajectoryIds.add(canonical);
  }
  const blockedLearners = new Set<string>();
  for (let i = 0; i < firewall.holdoutLearnerPseudoIds.length; i += 1) {
    const canonical = canonicalizeIdentifier(
      firewall.holdoutLearnerPseudoIds[i]!,
      "holdoutLearnerPseudoId",
    );
    assertNoRawPiiInText(canonical, "holdoutLearnerPseudoId");
    blockedLearners.add(canonical);
  }
  const blockedFamilies = new Set<string>();
  for (let i = 0; i < firewall.holdoutItemFamilyIds.length; i += 1) {
    const canonical = canonicalizeIdentifier(
      firewall.holdoutItemFamilyIds[i]!,
      "holdoutItemFamilyId",
    );
    assertNoRawPiiInText(canonical, "holdoutItemFamilyId");
    blockedFamilies.add(canonical);
  }

  const leakedTrajectoryIds: string[] = [];
  const leakedLearners = new Set<string>();
  const leakedFamilies = new Set<string>();

  for (let i = 0; i < trajectories.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(trajectories, i)) {
      throw new GepaInvalidPatchPayloadError(
        `Trajectory list contains sparse array hole at index ${i}`,
        "holdoutFirewall",
        [`trajectories[${i}]:sparse_array_hole`],
      );
    }
    const t = canonicalizeTrajectoryRecord(trajectories[i]!);
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
  // Post-normalization PII scan on rubric anchor expressions/AST tokens/premises using indexed loops.
  if (surface === "rubricAnchors") {
    const rules = patch.payload as readonly MisconceptionRubricRule[];
    for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx += 1) {
      const rule = rules[ruleIdx]!;
      const astTokens: string[] = [];
      for (let tIdx = 0; tIdx < rule.requiredAstTokens.length; tIdx += 1) {
        astTokens.push(rule.requiredAstTokens[tIdx]!);
      }
      assertNoRawPiiInText(
        normalizeAstEdit(astTokens.join("|")),
        `gepa_patch:rubricAnchors[${ruleIdx}].requiredAstTokens(post_norm)`,
      );
      let anchorIdx = 0;
      for (let pIdx = 0; pIdx < rule.positiveAnchors.length; pIdx += 1) {
        const anchor = rule.positiveAnchors[pIdx]!;
        assertNoRawPiiInText(
          normalizeAstEdit(anchor.normalizedAstEdit),
          `gepa_patch:rubricAnchors[${ruleIdx}].anchor[${anchorIdx}](post_norm)`,
        );
        anchorIdx += 1;
      }
      for (let nIdx = 0; nIdx < rule.negativeAnchors.length; nIdx += 1) {
        const anchor = rule.negativeAnchors[nIdx]!;
        assertNoRawPiiInText(
          normalizeAstEdit(anchor.normalizedAstEdit),
          `gepa_patch:rubricAnchors[${ruleIdx}].anchor[${anchorIdx}](post_norm)`,
        );
        anchorIdx += 1;
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

function copyStringArrayByIndex(items: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    out.push(items[i]!);
  }
  return out;
}

function cloneRubricAnchorByIndex(a: MisconceptionRubricRule["positiveAnchors"][number]) {
  return {
    anchorId: a.anchorId,
    label: a.label,
    conceptId: a.conceptId,
    firstErrorRuleId: a.firstErrorRuleId,
    normalizedAstEdit: a.normalizedAstEdit,
    establishedPremises: copyStringArrayByIndex(a.establishedPremises),
    expression: a.expression,
    rationale: a.rationale,
  };
}

function cloneRubricRule(rule: MisconceptionRubricRule): MisconceptionRubricRule {
  const positiveAnchors = [];
  for (let i = 0; i < rule.positiveAnchors.length; i += 1) {
    positiveAnchors.push(cloneRubricAnchorByIndex(rule.positiveAnchors[i]!));
  }
  const negativeAnchors = [];
  for (let i = 0; i < rule.negativeAnchors.length; i += 1) {
    negativeAnchors.push(cloneRubricAnchorByIndex(rule.negativeAnchors[i]!));
  }
  return {
    ruleId: rule.ruleId,
    conceptId: rule.conceptId,
    firstErrorRuleId: rule.firstErrorRuleId,
    requiredAstTokens: copyStringArrayByIndex(rule.requiredAstTokens),
    requiredMissingPremise: rule.requiredMissingPremise,
    positiveAnchors,
    negativeAnchors,
  };
}

function bumpPolicyVersion(version: string, suffix: string): string {
  return `${version}+${suffix}`;
}

/**
 * Applies a validated declarative patch to a cartridge policy, returning a new
 * immutable policy reconstructed strictly from validated declared fields via indexed loops.
 * Rejects forbidden surfaces, undeclared/malformed payload shapes, raw PII in
 * patch strings, and invalid rubric anchor pairs.
 */
export function validateAndApplyGepaPatch(
  policy: CartridgeDeclarativePolicy,
  patch: unknown,
  versionTag = "gepa",
): CartridgeDeclarativePolicy {
  assertNoRawPiiInValue(policy, "gepa_base_policy");
  assertNoRawPiiInText(versionTag, "gepa_version_tag");
  assertAllowedGepaPatch(patch);

  switch (patch.surface) {
    case "moveRules": {
      const merged = new Map<string, CartridgeMoveRule>();
      for (let i = 0; i < policy.moveRules.length; i += 1) {
        const r = cloneMoveRule(policy.moveRules[i]!);
        merged.set(r.id, r);
      }
      for (let i = 0; i < patch.payload.length; i += 1) {
        const r = cloneMoveRule(patch.payload[i]!);
        merged.set(r.id, r);
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
      const merged = new Map<string, CartridgeHintStep>();
      for (let i = 0; i < policy.hintLadder.length; i += 1) {
        const h = cloneHintStep(policy.hintLadder[i]!);
        merged.set(`${h.conceptId}::${h.stage}`, h);
      }
      for (let i = 0; i < patch.payload.length; i += 1) {
        const step = cloneHintStep(patch.payload[i]!);
        merged.set(`${step.conceptId}::${step.stage}`, step);
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
      const sanitizedRules: MisconceptionRubricRule[] = [];
      for (let i = 0; i < patch.payload.length; i += 1) {
        sanitizedRules.push(cloneRubricRule(patch.payload[i]!));
      }
      for (let i = 0; i < sanitizedRules.length; i += 1) {
        const rule = sanitizedRules[i]!;
        const check = validateRubricAnchorPair(rule);
        if (!check.valid) {
          throw new InvalidRubricAnchorPairError(
            `Rubric anchor rule "${rule.ruleId}" failed positive/negative anchor validation: ${check.issues.join(" ")}`,
            rule.ruleId,
            check.issues,
          );
        }
      }
      const merged = new Map<string, MisconceptionRubricRule>();
      for (let i = 0; i < policy.rubricAnchors.length; i += 1) {
        const r = cloneRubricRule(policy.rubricAnchors[i]!);
        merged.set(r.ruleId, r);
      }
      for (let i = 0; i < sanitizedRules.length; i += 1) {
        const rule = sanitizedRules[i]!;
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
      assertTemplateSlotContainer(policy.approvedTemplateSlots, "basePolicy.approvedTemplateSlots");
      assertTemplateSlotContainer(patch.payload, "approvedTemplateSlots.payload");
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
  // Scan the ENTIRE outer input container FIRST before reading ANY input.* property so getters never run.
  assertNoRawPiiInValue(input, "gepa_reflection_input");

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
  // Validate the original slot descriptors before copying enumerable policy data.
  assertTemplateSlotContainer(
    sanitizedPolicy.approvedTemplateSlots,
    "basePolicy.approvedTemplateSlots",
  );
  return deepClonePlainGepaValue(context, true);
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

class CyclicGepaValueError extends Error {}

function deepClonePlainGepaValue<T>(value: T, freeze = false, ancestors = new Set<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) throw new CyclicGepaValueError("Cyclic GEPA data.");
  ancestors.add(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(deepClonePlainGepaValue(value[i], freeze, ancestors));
    }
    ancestors.delete(value);
    return (freeze ? Object.freeze(out) : out) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !("value" in desc)) continue;
    const child = deepClonePlainGepaValue(desc.value, freeze, ancestors);
    if (!desc.enumerable || PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    Object.defineProperty(out, key, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(value);
  return (freeze ? Object.freeze(out) : out) as T;
}

export function runGepaOptimizationRound(
  input: RunGepaOptimizationRoundInput,
): GepaOptimizationRoundResult {
  // Scan the ENTIRE outer input container FIRST (before reading ANY input.* property!) so getters,
  // symbols, boxed primitives, non-plain arrays, or raw PII fail closed without invoking user code.
  assertNoRawPiiInValue(input, "gepa_round", undefined, {
    allowedFunctionPaths: GEPA_ROUND_ALLOWED_FUNCTION_PATHS,
  });
  assertDisjointSplitInvariants(input.split);

  // Snapshot paretoOptions BEFORE scoreCandidate callback can run so callbacks cannot tamper with thresholds.
  const safeParetoOptions = deepClonePlainGepaValue(input.paretoOptions);

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
    proposed.push(deepClonePlainGepaValue(generated, true));
  }

  const extraList = input.extraCandidatePatches;
  if (extraList !== undefined) {
    for (let eIdx = 0; eIdx < extraList.length; eIdx += 1) {
      if (!Object.prototype.hasOwnProperty.call(extraList, eIdx)) {
        throw new GepaInvalidPatchPayloadError(
          `extraCandidatePatches contains sparse array hole at index ${eIdx}`,
          "extraCandidatePatches",
          [`extraCandidatePatches[${eIdx}]:sparse_array_hole`],
        );
      }
      const extra = extraList[eIdx]!;
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
        if (!Object.prototype.hasOwnProperty.call(extra.patches, i)) {
          throw new GepaInvalidPatchPayloadError(
            `extraCandidatePatches[${eIdx}].patches contains sparse array hole at index ${i}`,
            "extraCandidatePatches",
            [`extraCandidatePatches[${eIdx}].patches[${i}]:sparse_array_hole`],
          );
        }
        const rawPatch = extra.patches[i];
        policy = validateAndApplyGepaPatch(policy, rawPatch, `ext_${i + 1}`);
        applied.push(deepClonePlainGepaValue(rawPatch as GepaSurfacePatch, true));
      }
      proposed.push(
        deepClonePlainGepaValue(
          {
            candidateId: canonicalExtraId,
            policy: { ...policy, policyId: canonicalExtraId },
            appliedPatches: applied,
          },
          true,
        ),
      );
    }
  }

  // Capture frozen internal candidate snapshots BEFORE calling scoreCandidate, and pass an
  // independent deep-cloned copy to scoreCandidate so in-place callback mutations cannot alter
  // validated candidate policies, IDs, Pareto inputs, or returned outputs.
  const frozenProposed: readonly GepaProposedCandidate[] = Object.freeze([...proposed]);
  const rawReceipts: unknown[] = [];
  for (let i = 0; i < frozenProposed.length; i += 1) {
    const candidateCopyForScorer = deepClonePlainGepaValue(frozenProposed[i]!);
    rawReceipts.push(input.scoreCandidate(candidateCopyForScorer));
  }

  // Scan ALL raw scorer receipts for PII FIRST before any CandidateIdentityError can fire,
  // and immediately snapshot plain receipts so callback-retained references cannot mutate them later.
  const snapshottedReceipts: unknown[] = [];
  for (let i = 0; i < frozenProposed.length; i += 1) {
    const raw = rawReceipts[i];
    assertNoRawPiiInValue(raw, `scorer_receipt[${frozenProposed[i]!.candidateId}]`);
    try {
      snapshottedReceipts.push(isPlainObject(raw) ? deepClonePlainGepaValue(raw) : raw);
    } catch (error) {
      if (!(error instanceof CyclicGepaValueError)) throw error;
      // The existing malformed-receipt path vetoes this candidate under its proposed ID.
      snapshottedReceipts.push(null);
    }
  }

  // Pre-collect all candidateIds across proposed candidates, baseline, and raw receipts so any
  // synthetic malformed-receipt ID can never collide with a valid caller candidateId.
  const reservedIds = new Set<string>();
  const rawBaseline = safeParetoOptions.baseline as unknown;
  if (isPlainObject(rawBaseline) && typeof rawBaseline.candidateId === "string") {
    reservedIds.add(rawBaseline.candidateId);
    const trimmedBase = rawBaseline.candidateId.normalize("NFKC").trim();
    if (trimmedBase.length > 0) reservedIds.add(trimmedBase);
  }
  for (let i = 0; i < frozenProposed.length; i += 1) {
    reservedIds.add(frozenProposed[i]!.candidateId);
  }
  for (let i = 0; i < snapshottedReceipts.length; i += 1) {
    const rawReceipt = snapshottedReceipts[i];
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

  const candidateMetrics: CartridgeCandidateMetrics[] = [];
  for (let idx = 0; idx < frozenProposed.length; idx += 1) {
    const candidate = frozenProposed[idx]!;
    const rawReceipt = snapshottedReceipts[idx];

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
      candidateMetrics.push(makeMalformedVetoReceipt());
      continue;
    }
    const rawReceiptId = rawReceipt.candidateId;
    if (typeof rawReceiptId !== "string" || rawReceiptId.normalize("NFKC").trim().length === 0) {
      candidateMetrics.push(makeMalformedVetoReceipt());
      continue;
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
    candidateMetrics.push(
      canonicalReceiptId === typedReceipt.candidateId
        ? typedReceipt
        : { ...typedReceipt, candidateId: canonicalReceiptId },
    );
  }

  const pareto = evaluateParetoFrontierAndPromotion(candidateMetrics, safeParetoOptions);

  return {
    reflectionContext,
    candidates: deepClonePlainGepaValue(frozenProposed, true),
    pareto,
  };
}
