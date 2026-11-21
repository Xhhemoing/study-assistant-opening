import {
  CartridgePiiViolationError,
  FORBIDDEN_PII_FIELDS,
  type AnchorPairValidationResult,
  type ClusteringOptions,
  type ClusteringSummary,
  type ErrorTrajectoryCluster,
  type ErrorTrajectoryRecord,
  type ExtractedTrajectoryFeatures,
  type MisconceptionRubricRule,
  type RubricAnchorExample,
} from "./types";

const FORBIDDEN_PII_FIELD_SET: ReadonlySet<string> = new Set(FORBIDDEN_PII_FIELDS);
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const VALID_PSEUDO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;
const FORBIDDEN_PSEUDO_PREFIXES = ["raw:", "email:", "mail:", "phone:", "tel:", "ssn:", "name:"];

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePremise(premise: string): string {
  return premise
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([!=<>+-/*(),])\s*/g, "$1")
    .trim();
}

/** Canonicalizes an AST edit descriptor into a deterministic sorted token stream. */
export function normalizeAstEdit(rawAstEdit: string): string {
  const parts = rawAstEdit
    .split(/[|;\n]+/)
    .map((part) =>
      part
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\s*([(),=<>!+\-*/])\s*/g, "$1")
        .toUpperCase(),
    )
    .filter((part) => part.length > 0);
  return [...new Set(parts)].sort((a, b) => a.localeCompare(b)).join("|");
}

function tokenizeNormalizedAst(normalizedAstEdit: string): string[] {
  if (!normalizedAstEdit) return [];
  const clauses = normalizedAstEdit.split("|").filter((c) => c.length > 0);
  const subTokens: string[] = [];
  for (const clause of clauses) {
    subTokens.push(clause);
    for (const piece of clause.split(/[^A-Z0-9_]+/).filter((p) => p.length > 0)) {
      subTokens.push(piece);
    }
  }
  return [...new Set(subTokens)];
}

/**
 * Validates that a trajectory carries only pseudonymized learner identifiers
 * and contains zero raw PII fields or embedded contact strings.
 */
export function assertPseudonymizedTrajectory(record: ErrorTrajectoryRecord): void {
  const offendingFields: string[] = [];
  const rawObject = record as unknown as Record<string, unknown>;

  for (const key of Object.keys(rawObject)) {
    const normalized = normalizeFieldKey(key);
    if (FORBIDDEN_PII_FIELD_SET.has(normalized)) {
      offendingFields.push(key);
    }
  }

  const pseudo = record.learnerPseudoId;
  if (typeof pseudo !== "string" || !VALID_PSEUDO_ID_PATTERN.test(pseudo)) {
    offendingFields.push("learnerPseudoId:invalid_format");
  } else {
    const lowerPseudo = pseudo.toLowerCase();
    if (
      EMAIL_PATTERN.test(pseudo) ||
      PHONE_PATTERN.test(pseudo) ||
      pseudo.includes("@") ||
      FORBIDDEN_PSEUDO_PREFIXES.some((prefix) => lowerPseudo.startsWith(prefix))
    ) {
      offendingFields.push("learnerPseudoId:raw_pii_detected");
    }
  }

  if (typeof record.snippet === "string") {
    if (EMAIL_PATTERN.test(record.snippet) || PHONE_PATTERN.test(record.snippet)) {
      offendingFields.push("snippet:raw_pii_detected");
    }
  }

  if (offendingFields.length > 0) {
    throw new CartridgePiiViolationError(
      `Trajectory ${record.trajectoryId} violated pseudonymization boundary: ${offendingFields.join(", ")}`,
      offendingFields,
      record.trajectoryId,
    );
  }
}

export function extractTrajectoryFeatures(
  record: ErrorTrajectoryRecord,
): ExtractedTrajectoryFeatures {
  assertPseudonymizedTrajectory(record);
  return {
    trajectoryId: record.trajectoryId,
    learnerPseudoId: record.learnerPseudoId,
    conceptId: record.conceptId.trim(),
    firstErrorRuleId: record.firstErrorRuleId.trim(),
    normalizedAstEdit: normalizeAstEdit(record.normalizedAstEdit),
    missingPremise: normalizePremise(record.missingPremise),
    hintStage: record.hintStage,
    itemFamilyId: record.itemFamilyId.trim(),
  };
}

/** Deterministic structural similarity in [0, 1] over normalized AST edit & missing premise. */
export function computeStructuralSimilarity(
  a: Pick<ExtractedTrajectoryFeatures, "normalizedAstEdit" | "missingPremise">,
  b: Pick<ExtractedTrajectoryFeatures, "normalizedAstEdit" | "missingPremise">,
): number {
  const tokensA = new Set(tokenizeNormalizedAst(normalizeAstEdit(a.normalizedAstEdit)));
  const tokensB = new Set(tokenizeNormalizedAst(normalizeAstEdit(b.normalizedAstEdit)));

  let astSim: number;
  if (tokensA.size === 0 && tokensB.size === 0) {
    astSim = 1;
  } else if (tokensA.size === 0 || tokensB.size === 0) {
    astSim = 0;
  } else {
    let intersection = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) intersection += 1;
    }
    const union = tokensA.size + tokensB.size - intersection;
    astSim = union > 0 ? intersection / union : 0;
  }

  const premA = normalizePremise(a.missingPremise);
  const premB = normalizePremise(b.missingPremise);
  let premSim: number;
  if (premA === premB) {
    premSim = 1;
  } else if (!premA || !premB) {
    premSim = 0;
  } else {
    const wordsA = new Set(premA.split(/[^a-z0-9!=<>]+/).filter((w) => w.length > 0));
    const wordsB = new Set(premB.split(/[^a-z0-9!=<>]+/).filter((w) => w.length > 0));
    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap += 1;
    }
    const union = wordsA.size + wordsB.size - overlap;
    premSim = union > 0 ? overlap / union : 0;
  }

  return 0.7 * astSim + 0.3 * premSim;
}

/**
 * Deterministically buckets pseudonymized error trajectories by
 * `(conceptId, firstErrorRuleId)`, clusters structural AST-edit / missing-premise
 * similarity, and marks clusters below `minSupport` (default 5) as `observation_only`.
 */
export function clusterErrorTrajectories(
  trajectories: readonly ErrorTrajectoryRecord[],
  options: ClusteringOptions = {},
): ClusteringSummary {
  const minSupport = options.minSupport ?? 5;
  const similarityThreshold = options.similarityThreshold ?? 0.72;

  const features = trajectories.map((t) => extractTrajectoryFeatures(t));
  const buckets = new Map<string, ExtractedTrajectoryFeatures[]>();

  for (const feat of features) {
    const bucketKey = `${feat.conceptId}::${feat.firstErrorRuleId}`;
    const list = buckets.get(bucketKey);
    if (list) {
      list.push(feat);
    } else {
      buckets.set(bucketKey, [feat]);
    }
  }

  const sortedBucketKeys = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  const clusters: ErrorTrajectoryCluster[] = [];

  for (const bucketKey of sortedBucketKeys) {
    const items = [...(buckets.get(bucketKey) ?? [])].sort((a, b) => {
      const astCmp = a.normalizedAstEdit.localeCompare(b.normalizedAstEdit);
      if (astCmp !== 0) return astCmp;
      const premCmp = a.missingPremise.localeCompare(b.missingPremise);
      if (premCmp !== 0) return premCmp;
      return a.trajectoryId.localeCompare(b.trajectoryId);
    });

    interface WorkingCluster {
      readonly leader: ExtractedTrajectoryFeatures;
      readonly members: ExtractedTrajectoryFeatures[];
      similaritySum: number;
    }

    const working: WorkingCluster[] = [];
    for (const item of items) {
      let bestCluster: WorkingCluster | null = null;
      let bestSim = -1;

      for (const candidate of working) {
        const sim = computeStructuralSimilarity(item, candidate.leader);
        if (sim >= similarityThreshold && sim > bestSim) {
          bestSim = sim;
          bestCluster = candidate;
        }
      }

      if (bestCluster) {
        bestCluster.members.push(item);
        bestCluster.similaritySum += bestSim;
      } else {
        working.push({ leader: item, members: [item], similaritySum: 1 });
      }
    }

    working.forEach((group, groupIndex) => {
      const stageDist: Record<string, number> = {};
      const learners = new Set<string>();
      const families = new Set<string>();
      const trajectoryIds: string[] = [];

      for (const member of group.members) {
        const stageKey = String(member.hintStage);
        stageDist[stageKey] = (stageDist[stageKey] ?? 0) + 1;
        learners.add(member.learnerPseudoId);
        families.add(member.itemFamilyId);
        trajectoryIds.push(member.trajectoryId);
      }

      const supportCount = group.members.length;
      const status = supportCount >= minSupport ? "actionable_candidate" : "observation_only";

      clusters.push({
        clusterId: `cluster::${bucketKey}::${groupIndex + 1}`,
        bucketKey,
        conceptId: group.leader.conceptId,
        firstErrorRuleId: group.leader.firstErrorRuleId,
        centroidAstEdit: group.leader.normalizedAstEdit,
        missingPremise: group.leader.missingPremise,
        hintStageDistribution: stageDist,
        supportCount,
        uniqueLearnerCount: learners.size,
        itemFamilyIds: [...families].sort((a, b) => a.localeCompare(b)),
        trajectoryIds: trajectoryIds.sort((a, b) => a.localeCompare(b)),
        status,
        cohesionScore: Number((group.similaritySum / supportCount).toFixed(6)),
      });
    });
  }

  return {
    totalTrajectories: trajectories.length,
    minSupport,
    similarityThreshold,
    clusters,
    actionableClusters: clusters.filter((c) => c.status === "actionable_candidate"),
    observationOnlyClusters: clusters.filter((c) => c.status === "observation_only"),
  };
}

/**
 * Evaluates whether a misconception rubric rule fires on an anchor/trajectory.
 * Fires iff concept + firstErrorRule match, all required AST tokens appear,
 * AND the required missing premise has NOT been explicitly established.
 */
export function matchesRubricRule(
  rule: MisconceptionRubricRule,
  example: Pick<
    RubricAnchorExample,
    "conceptId" | "firstErrorRuleId" | "normalizedAstEdit" | "establishedPremises"
  >,
): boolean {
  if (example.conceptId.trim() !== rule.conceptId.trim()) return false;
  if (example.firstErrorRuleId.trim() !== rule.firstErrorRuleId.trim()) return false;

  const normalizedExampleAst = normalizeAstEdit(example.normalizedAstEdit);
  const exampleTokens = new Set(tokenizeNormalizedAst(normalizedExampleAst));

  const requiredTokens = rule.requiredAstTokens
    .map((t) => normalizeAstEdit(t))
    .filter((t) => t.length > 0);
  if (requiredTokens.length === 0) return false;

  for (const token of requiredTokens) {
    if (!exampleTokens.has(token) && !normalizedExampleAst.includes(token)) {
      return false;
    }
  }

  const normalizedMissingPremise = normalizePremise(rule.requiredMissingPremise);
  if (!normalizedMissingPremise) return false;

  const established = new Set(
    example.establishedPremises.map((p) => normalizePremise(p)).filter((p) => p.length > 0),
  );
  if (established.has(normalizedMissingPremise)) {
    // Premise is explicitly established -> valid derivation, NOT a misconception!
    return false;
  }

  return true;
}

/**
 * Positive/Negative Rubric Anchor Pair Validator:
 * Every candidate misconception rubric rule must carry >= 1 positive anchor AND
 * >= 1 contrasting valid negative anchor, firing on ALL positive anchors and
 * ZERO negative anchors.
 */
export function validateRubricAnchorPair(
  rule: MisconceptionRubricRule,
): AnchorPairValidationResult {
  const issues: string[] = [];
  const missedPositiveAnchorIds: string[] = [];
  const falsePositiveNegativeAnchorIds: string[] = [];

  if (rule.positiveAnchors.length === 0) {
    issues.push(`Rule ${rule.ruleId} must define at least one positive anchor.`);
  }
  if (rule.negativeAnchors.length === 0) {
    issues.push(`Rule ${rule.ruleId} must define at least one contrasting valid negative anchor.`);
  }
  if (rule.requiredAstTokens.length === 0) {
    issues.push(`Rule ${rule.ruleId} must specify at least one requiredAstToken.`);
  }
  if (!normalizePremise(rule.requiredMissingPremise)) {
    issues.push(`Rule ${rule.ruleId} must specify a non-empty requiredMissingPremise.`);
  }

  let positiveFiredCount = 0;
  for (const pos of rule.positiveAnchors) {
    if (pos.label !== "positive") {
      issues.push(`Positive anchor ${pos.anchorId} has mismatched label "${pos.label}".`);
      missedPositiveAnchorIds.push(pos.anchorId);
      continue;
    }
    if (matchesRubricRule(rule, pos)) {
      positiveFiredCount += 1;
    } else {
      missedPositiveAnchorIds.push(pos.anchorId);
      issues.push(`Rule ${rule.ruleId} failed to fire on positive anchor ${pos.anchorId}.`);
    }
  }

  let negativeFalsePositiveCount = 0;
  for (const neg of rule.negativeAnchors) {
    if (neg.label !== "negative") {
      issues.push(`Negative anchor ${neg.anchorId} has mismatched label "${neg.label}".`);
      falsePositiveNegativeAnchorIds.push(neg.anchorId);
      continue;
    }
    if (matchesRubricRule(rule, neg)) {
      negativeFalsePositiveCount += 1;
      falsePositiveNegativeAnchorIds.push(neg.anchorId);
      issues.push(
        `Rule ${rule.ruleId} falsely fired on contrasting valid negative anchor ${neg.anchorId}.`,
      );
    }
  }

  const valid =
    issues.length === 0 &&
    rule.positiveAnchors.length > 0 &&
    rule.negativeAnchors.length > 0 &&
    positiveFiredCount === rule.positiveAnchors.length &&
    negativeFalsePositiveCount === 0;

  return {
    valid,
    ruleId: rule.ruleId,
    positiveCount: rule.positiveAnchors.length,
    negativeCount: rule.negativeAnchors.length,
    positiveFiredCount,
    negativeFalsePositiveCount,
    missedPositiveAnchorIds,
    falsePositiveNegativeAnchorIds,
    issues,
  };
}
