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
const UUID_PATTERN =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN =
  /(?<![\d.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d.])/;
const INTL_PHONE_PATTERN =
  /(?<![\w.])(?:\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}|\+\d{8,15})(?![\d.])/;
const UNFORMATTED_PHONE_PATTERN =
  /(?<![0-9A-Za-z_.])\d{10,11}(?![0-9A-Za-z_]|\.\d)/;
const SSN_PATTERN = /(?<![\d.])\d{3}-\d{2}-\d{4}(?![\d.])/;
const TOKEN_URL_PATTERN =
  /https?:\/\/[^\s]*?(?:[?&]\s*(?:token|access_token|auth|api_key|apikey|secret|password|passwd|session|sid|jwt|key)\s*=|[^/\s@]+:[^/\s@]+@)/i;
const SPACED_TOKEN_URL_PATTERN =
  /https?:\/\/\S+(?:\s*[?&]\s*(?:token|access_token|auth|api_key|apikey|secret|password|passwd|session|sid|jwt|key)\s*=\s*\S+)/i;
const JWT_PATTERN = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/;
const BEARER_TOKEN_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/-]{8,}\b/i;
const RAW_PII_ASSIGNMENT_PATTERN =
  /\b(?:student[_\s-]?id|raw[_\s-]?user[_\s-]?id|user[_\s-]?id|full[_\s-]?name|real[_\s-]?name|email|phone|tel|ssn|access[_\s-]?token|api[_\s-]?key|password|passwd|secret)\s*[:=]\s*[^\s,;]+/i;
const RAW_PII_PREFIX_PATTERN =
  /(?:^|[\s(|;,])(?:raw|email|mail|phone|tel|ssn|name):[^\s,;)|]+/i;

const VALID_PSEUDO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;
const FORBIDDEN_PSEUDO_PREFIXES = ["raw:", "email:", "mail:", "phone:", "tel:", "ssn:", "name:"];

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePremise(premise: string): string {
  return premise
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([!=<>+-/*(),])\s*/g, "$1")
    .trim();
}

/**
 * Canonicalizes an identifier via Unicode NFKC normalization and whitespace trimming.
 * Throws `CartridgePiiViolationError` if non-string or empty after trimming.
 */
export function canonicalizeIdentifier(
  raw: string,
  fieldName: string,
  trajectoryId?: string,
): string {
  if (typeof raw !== "string") {
    throw new CartridgePiiViolationError(
      `${fieldName} must be a non-empty string`,
      [`${fieldName}:non_string`],
      trajectoryId,
    );
  }
  const normalized = raw.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new CartridgePiiViolationError(
      `${fieldName} must be non-empty after NFKC normalization and trimming`,
      [`${fieldName}:empty`],
      trajectoryId,
    );
  }
  return normalized;
}

function detectRawPiiReasonsInText(text: string): string[] {
  const nfkc = text.normalize("NFKC");
  const unmaskedCollapsed = nfkc.replace(/\s*([!=<>+-/*(),:?&])\s*/g, "$1");
  const unmaskedForms = new Set<string>([text, nfkc, unmaskedCollapsed]);

  const reasons = new Set<string>();
  // Run email, URL/credential, auth-token, and raw-PII-identifier checks on UNMASKED text first
  // so UUID local-part emails (e.g. <uuid>@example.com) and Bearer <uuid> tokens are never hidden.
  for (const form of unmaskedForms) {
    if (EMAIL_PATTERN.test(form)) reasons.add("email");
    if (TOKEN_URL_PATTERN.test(form) || SPACED_TOKEN_URL_PATTERN.test(form)) {
      reasons.add("url_with_credentials_or_token");
    }
    if (JWT_PATTERN.test(form) || BEARER_TOKEN_PATTERN.test(form)) {
      reasons.add("auth_token");
    }
    if (RAW_PII_ASSIGNMENT_PATTERN.test(form) || RAW_PII_PREFIX_PATTERN.test(form)) {
      reasons.add("raw_pii_identifier");
    }
  }

  // Mask canonical 8-4-4-4-12 UUIDs ONLY for phone and SSN detectors so UUID tails like
  // "-a12345678901" never false-positive as phone numbers or SSNs.
  const rawMasked = text.replace(UUID_PATTERN, "<UUID>");
  const nfkcMasked = nfkc.replace(UUID_PATTERN, "<UUID>");
  const collapsedMasked = nfkcMasked.replace(/\s*([!=<>+-/*(),:?&])\s*/g, "$1");

  for (const form of new Set<string>([rawMasked, nfkcMasked, collapsedMasked])) {
    if (SSN_PATTERN.test(form)) reasons.add("ssn");
  }
  for (const form of new Set<string>([rawMasked, nfkcMasked])) {
    if (
      PHONE_PATTERN.test(form) ||
      INTL_PHONE_PATTERN.test(form) ||
      UNFORMATTED_PHONE_PATTERN.test(form)
    ) {
      reasons.add("phone");
    }
  }
  // Check formatted/international phone numbers on collapsed form as well, without running
  // UNFORMATTED_PHONE_PATTERN on punctuation-collapsed strings.
  if (PHONE_PATTERN.test(collapsedMasked) || INTL_PHONE_PATTERN.test(collapsedMasked)) {
    reasons.add("phone");
  }
  return [...reasons];
}

export interface RawPiiScanOptions {
  /**
   * Optional exact full schema paths (e.g., `"root.evaluatedAtMs"`) explicitly
   * exempted from numeric SSN/phone/ID digit-length checks. Never exempts by bare key name.
   */
  readonly allowedNumericMetadataPaths?: ReadonlySet<string>;
}

function sanitizeTrajectoryIdForError(trajectoryId: string | undefined): string | undefined {
  if (trajectoryId === undefined) return undefined;
  return detectRawPiiReasonsInText(trajectoryId).length > 0
    ? "[redacted_trajectory_id]"
    : trajectoryId;
}

/**
 * Fails closed (`CartridgePiiViolationError`) if `text` contains raw email,
 * phone, SSN, credentialed/tokenized URL, auth token, or raw student/user PII markers.
 */
export function assertNoRawPiiInText(
  text: string,
  fieldPath: string,
  trajectoryId?: string,
): void {
  const reasons = detectRawPiiReasonsInText(text);
  if (reasons.length > 0) {
    const safeTrajectoryId = sanitizeTrajectoryIdForError(trajectoryId);
    throw new CartridgePiiViolationError(
      `Raw PII detected at ${fieldPath}: ${reasons.join(", ")}`,
      reasons.map((r) => `${fieldPath}:${r}`),
      safeTrajectoryId,
    );
  }
}

function collectRawPiiViolations(
  value: unknown,
  pathLabel: string,
  out: string[],
  seen: WeakSet<object>,
  skipKeys?: ReadonlySet<string>,
  allowedNumericMetadataPaths?: ReadonlySet<string>,
): void {
  if (typeof value === "string") {
    const reasons = detectRawPiiReasonsInText(value);
    for (const reason of reasons) {
      out.push(`${pathLabel}:${reason}`);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    if (!allowedNumericMetadataPaths?.has(pathLabel)) {
      const isInt = typeof value === "bigint" || (Number.isFinite(value) && Number.isInteger(value));
      if (isInt) {
        const absDigits =
          typeof value === "bigint"
            ? (value < 0n ? -value : value).toString()
            : Math.abs(value).toString();
        if (absDigits.length === 9) {
          out.push(`${pathLabel}:numeric_ssn_pii`);
        } else if (absDigits.length === 10 || absDigits.length === 11) {
          out.push(`${pathLabel}:numeric_phone_pii`);
        } else if (absDigits.length >= 15 && absDigits.length <= 18) {
          out.push(`${pathLabel}:numeric_id_pii`);
        }
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectRawPiiViolations(
        value[i],
        `${pathLabel}[${i}]`,
        out,
        seen,
        undefined,
        allowedNumericMetadataPaths,
      );
    }
    return;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const normalizedKey = normalizeFieldKey(key);
    const isForbiddenField = FORBIDDEN_PII_FIELD_SET.has(normalizedKey);
    const keyReasons = detectRawPiiReasonsInText(key);
    const isSensitiveOrPiiKey = isForbiddenField || keyReasons.length > 0;
    const safeSegment = isSensitiveOrPiiKey ? "[redacted_key]" : key;
    const childPath = `${pathLabel}.${safeSegment}`;

    if (isForbiddenField) {
      out.push(`${childPath}:forbidden_pii_field`);
    }
    for (const reason of keyReasons) {
      out.push(`${childPath}:key_${reason}`);
    }
    if (skipKeys?.has(key)) continue;
    collectRawPiiViolations(
      (value as Record<string, unknown>)[key],
      childPath,
      out,
      seen,
      undefined,
      allowedNumericMetadataPaths,
    );
  }
}

/**
 * Recursively inspects all keys and leaves of an arbitrary value (such as a
 * trajectory, scorer receipt, or GEPA patch) and throws `CartridgePiiViolationError`
 * on any raw PII without echoing sensitive/PII-bearing keys.
 */
export function assertNoRawPiiInValue(
  value: unknown,
  rootLabel: string,
  trajectoryId?: string,
  options?: RawPiiScanOptions,
): void {
  const offending: string[] = [];
  collectRawPiiViolations(
    value,
    rootLabel,
    offending,
    new WeakSet(),
    undefined,
    options?.allowedNumericMetadataPaths,
  );
  if (offending.length > 0) {
    const safeTrajectoryId = sanitizeTrajectoryIdForError(trajectoryId);
    throw new CartridgePiiViolationError(
      `Raw PII violation in ${rootLabel}: ${offending.join(", ")}`,
      offending,
      safeTrajectoryId,
    );
  }
}

/** Canonicalizes an AST edit descriptor into a deterministic sorted token stream. */
export function normalizeAstEdit(rawAstEdit: string): string {
  const parts = rawAstEdit
    .normalize("NFKC")
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
 * Validates that a trajectory carries only canonical pseudonymized learner/family
 * identifiers and contains zero raw PII fields or embedded PII strings across
 * every field (`normalizedAstEdit`, `missingPremise`, `snippet`, and nested leaves).
 */
export function assertPseudonymizedTrajectory(record: ErrorTrajectoryRecord): void {
  const offendingFields: string[] = [];
  const rawObject = record as unknown as Record<string, unknown>;
  const rawTrajectoryId = typeof record.trajectoryId === "string" ? record.trajectoryId : undefined;

  let canonicalPseudo = "";
  try {
    canonicalPseudo = canonicalizeIdentifier(
      record.learnerPseudoId,
      "learnerPseudoId",
      rawTrajectoryId,
    );
  } catch (err) {
    if (err instanceof CartridgePiiViolationError) {
      offendingFields.push(...err.offendingFields);
    } else {
      offendingFields.push("learnerPseudoId:invalid");
    }
  }

  try {
    canonicalizeIdentifier(record.itemFamilyId, "itemFamilyId", rawTrajectoryId);
  } catch (err) {
    if (err instanceof CartridgePiiViolationError) {
      offendingFields.push(...err.offendingFields);
    } else {
      offendingFields.push("itemFamilyId:invalid");
    }
  }

  try {
    canonicalizeIdentifier(record.trajectoryId, "trajectoryId", rawTrajectoryId);
  } catch (err) {
    if (err instanceof CartridgePiiViolationError) {
      offendingFields.push(...err.offendingFields);
    } else {
      offendingFields.push("trajectoryId:invalid");
    }
  }

  if (canonicalPseudo.length > 0) {
    if (!VALID_PSEUDO_ID_PATTERN.test(canonicalPseudo)) {
      offendingFields.push("learnerPseudoId:invalid_format");
    } else {
      const lowerPseudo = canonicalPseudo.toLowerCase();
      const pseudoPiiReasons = detectRawPiiReasonsInText(canonicalPseudo);
      if (
        pseudoPiiReasons.length > 0 ||
        canonicalPseudo.includes("@") ||
        FORBIDDEN_PSEUDO_PREFIXES.some((prefix) => lowerPseudo.startsWith(prefix))
      ) {
        offendingFields.push(
          ...pseudoPiiReasons.map((r) => `learnerPseudoId:${r}`),
          "learnerPseudoId:raw_pii_detected",
        );
      }
    }
  }

  // Scan ALL keys and string leaves (including learnerPseudoId, normalizedAstEdit, missingPremise, snippet, and any extra/nested steps).
  collectRawPiiViolations(rawObject, "trajectory", offendingFields, new WeakSet());

  // Also scan post-normalization forms so whitespace-obfuscated tokens/URLs cannot emerge after normalization.
  if (typeof record.normalizedAstEdit === "string") {
    const postNormAst = normalizeAstEdit(record.normalizedAstEdit);
    for (const reason of detectRawPiiReasonsInText(postNormAst)) {
      offendingFields.push(`trajectory.normalizedAstEdit(post_norm):${reason}`);
    }
  }
  if (typeof record.missingPremise === "string") {
    const postNormPremise = normalizePremise(record.missingPremise);
    for (const reason of detectRawPiiReasonsInText(postNormPremise)) {
      offendingFields.push(`trajectory.missingPremise(post_norm):${reason}`);
    }
  }

  if (offendingFields.length > 0) {
    const safeTrajectoryId = sanitizeTrajectoryIdForError(rawTrajectoryId);
    const deduped = [...new Set(offendingFields)];
    throw new CartridgePiiViolationError(
      `Trajectory ${safeTrajectoryId ?? "[unknown]"} violated pseudonymization boundary: ${deduped.join(", ")}`,
      deduped,
      safeTrajectoryId,
    );
  }
}

/**
 * Validates pseudonymization & PII constraints and returns a trajectory whose
 * `trajectoryId`, `learnerPseudoId`, `itemFamilyId`, `conceptId`, and `firstErrorRuleId`
 * are NFKC-normalized and trimmed.
 */
export function canonicalizeTrajectoryRecord(
  record: ErrorTrajectoryRecord,
): ErrorTrajectoryRecord {
  assertPseudonymizedTrajectory(record);
  const trajectoryId = canonicalizeIdentifier(record.trajectoryId, "trajectoryId");
  const learnerPseudoId = canonicalizeIdentifier(
    record.learnerPseudoId,
    "learnerPseudoId",
    trajectoryId,
  );
  const itemFamilyId = canonicalizeIdentifier(record.itemFamilyId, "itemFamilyId", trajectoryId);
  const conceptId = canonicalizeIdentifier(record.conceptId, "conceptId", trajectoryId);
  const firstErrorRuleId = canonicalizeIdentifier(
    record.firstErrorRuleId,
    "firstErrorRuleId",
    trajectoryId,
  );
  return {
    ...record,
    trajectoryId,
    learnerPseudoId,
    itemFamilyId,
    conceptId,
    firstErrorRuleId,
  };
}

export function extractTrajectoryFeatures(
  record: ErrorTrajectoryRecord,
): ExtractedTrajectoryFeatures {
  const canonical = canonicalizeTrajectoryRecord(record);
  const normalizedAstEdit = normalizeAstEdit(canonical.normalizedAstEdit);
  const missingPremise = normalizePremise(canonical.missingPremise);
  assertNoRawPiiInText(
    normalizedAstEdit,
    "trajectory.normalizedAstEdit:post_norm",
    canonical.trajectoryId,
  );
  assertNoRawPiiInText(
    missingPremise,
    "trajectory.missingPremise:post_norm",
    canonical.trajectoryId,
  );
  return {
    trajectoryId: canonical.trajectoryId,
    learnerPseudoId: canonical.learnerPseudoId,
    conceptId: canonical.conceptId,
    firstErrorRuleId: canonical.firstErrorRuleId,
    normalizedAstEdit,
    missingPremise,
    hintStage: canonical.hintStage,
    itemFamilyId: canonical.itemFamilyId,
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

  assertNoRawPiiInValue(clusters, "clustering_output");

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
  if (example.conceptId.normalize("NFKC").trim() !== rule.conceptId.normalize("NFKC").trim()) {
    return false;
  }
  if (
    example.firstErrorRuleId.normalize("NFKC").trim() !==
    rule.firstErrorRuleId.normalize("NFKC").trim()
  ) {
    return false;
  }

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
