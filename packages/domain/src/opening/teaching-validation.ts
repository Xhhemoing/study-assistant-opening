/**
 * V2-09 teaching validation — layered publish gate (structure ≠ fact).
 * Pure domain: no provider I/O, no pack assembly, no DDL.
 * Tool timeout stays unknown; never fake authority.
 */

export type LayerOutcome = "pass" | "fail" | "unknown" | "skipped";

export type ValidationLayerId =
  | "schema"
  | "source_identity"
  | "claim_support"
  | "tool_result"
  | "action_permission";

export type LayerResult = {
  layer: ValidationLayerId;
  outcome: LayerOutcome;
  /** Human-readable; never used as fake authority proof by itself. */
  reason: string;
  details?: Record<string, unknown>;
};

export type PresentationPolicy =
  | { kind: "authoritative"; allowsFormalScoring: true }
  | { kind: "discussion_draft"; allowsFormalScoring: false; label: string }
  | { kind: "blocked"; allowsFormalScoring: false; reason: string };

/** Mapped onto existing teachingVerificationStatusSchema — no new enum. */
export type NextVerificationStatus =
  | "structure_ok"
  | "needs_check"
  | "verified"
  | "rejected"
  | "stale"
  | "unchecked";

export type ValidationReport = {
  activityId: string;
  structurePassed: boolean;
  factPassed: boolean;
  layers: LayerResult[];
  nextVerificationStatus: NextVerificationStatus;
  presentation: PresentationPolicy;
};

const STRUCTURE_LAYERS: ReadonlySet<ValidationLayerId> = new Set([
  "schema",
  "source_identity",
]);

const REQUIRED_FOR_VERIFIED: ReadonlySet<ValidationLayerId> = new Set([
  "schema",
  "source_identity",
  "claim_support",
]);

function layerOf(
  layers: LayerResult[],
  id: ValidationLayerId,
): LayerResult | undefined {
  return layers.find((l) => l.layer === id);
}

/**
 * true iff schema + source_identity are pass.
 * action_permission fail blocks interactable, not structure_ok alone.
 */
export function structurePassed(layers: LayerResult[]): boolean {
  const schema = layerOf(layers, "schema");
  const source = layerOf(layers, "source_identity");
  return schema?.outcome === "pass" && source?.outcome === "pass";
}

/**
 * true iff claim_support pass AND tool_result is pass or skipped;
 * tool_result unknown OR claim fail/conflict/uncovered → false.
 * Missing or skipped claim_support does NOT vacuously pass (soft gap #4).
 */
export function factPassed(layers: LayerResult[]): boolean {
  const claim = layerOf(layers, "claim_support");
  if (!claim || claim.outcome !== "pass") return false;

  const tool = layerOf(layers, "tool_result");
  if (!tool) return true; // tools optional when not probed
  if (tool.outcome === "pass" || tool.outcome === "skipped") return true;
  return false; // fail | unknown
}

function hasUnresolvedConflict(layers: LayerResult[]): boolean {
  return layers.some(
    (l) =>
      l.details?.unresolvedConflict === true ||
      l.details?.coverageStatus === "conflict" ||
      (typeof l.reason === "string" &&
        /unresolved\s+conflict/i.test(l.reason) &&
        l.outcome === "fail"),
  );
}

function hasRequiredUnknown(layers: LayerResult[]): boolean {
  for (const l of layers) {
    if (l.outcome !== "unknown") continue;
    if (REQUIRED_FOR_VERIFIED.has(l.layer) || l.layer === "tool_result") {
      return true;
    }
  }
  return false;
}

/**
 * structurePassed && factPassed && no unresolved conflict;
 * NEVER true when any required layer is unknown.
 */
export function mayPublishVerified(report: ValidationReport): boolean {
  if (!report.structurePassed || !report.factPassed) return false;
  if (hasRequiredUnknown(report.layers)) return false;
  if (hasUnresolvedConflict(report.layers)) return false;
  return true;
}

function decideNextStatus(layers: LayerResult[]): NextVerificationStatus {
  const structOk = structurePassed(layers);
  const factOk = factPassed(layers);
  const schema = layerOf(layers, "schema");
  const source = layerOf(layers, "source_identity");
  const claim = layerOf(layers, "claim_support");
  const tool = layerOf(layers, "tool_result");

  if (schema?.outcome === "fail" || source?.outcome === "fail") {
    return "rejected";
  }

  if (hasRequiredUnknown(layers)) {
    return "needs_check";
  }

  if (structOk && factOk && !hasUnresolvedConflict(layers)) {
    return "verified";
  }

  if (structOk) {
    // Structure ok but facts not: structure_ok unless still indeterminate
    if (claim?.outcome === "unknown" || tool?.outcome === "unknown") {
      return "needs_check";
    }
    return "structure_ok";
  }

  if (
    schema?.outcome === "unknown" ||
    source?.outcome === "unknown" ||
    schema?.outcome === "skipped" ||
    source?.outcome === "skipped"
  ) {
    return "needs_check";
  }

  return "needs_check";
}

/**
 * verified → authoritative; structure_ok/needs_check → discussion_draft;
 * rejected/blocked → blocked; never pretends non-verified is 权威讲解.
 */
export function presentationFor(
  status: string,
  report: ValidationReport,
): PresentationPolicy {
  if (status === "verified" && mayPublishVerified(report)) {
    return { kind: "authoritative", allowsFormalScoring: true };
  }
  if (status === "rejected" || status === "stale") {
    return {
      kind: "blocked",
      allowsFormalScoring: false,
      reason:
        status === "stale"
          ? "verification stale after privacy/epoch change"
          : "validation rejected",
    };
  }
  if (
    status === "structure_ok" ||
    status === "needs_check" ||
    status === "unchecked"
  ) {
    return {
      kind: "discussion_draft",
      allowsFormalScoring: false,
      label: "讨论草稿（未通过事实核验，不可作权威说明或正式评分依据）",
    };
  }
  // Fallback: never authoritative without verified
  return {
    kind: "discussion_draft",
    allowsFormalScoring: false,
    label: "讨论草稿（未通过事实核验，不可作权威说明或正式评分依据）",
  };
}

export function buildValidationReport(input: {
  activityId: string;
  layers: LayerResult[];
}): ValidationReport {
  const structOk = structurePassed(input.layers);
  const factOk = factPassed(input.layers);
  const nextVerificationStatus = decideNextStatus(input.layers);
  const draft: ValidationReport = {
    activityId: input.activityId,
    structurePassed: structOk,
    factPassed: factOk,
    layers: input.layers,
    nextVerificationStatus,
    presentation: { kind: "discussion_draft", allowsFormalScoring: false, label: "" },
  };
  draft.presentation = presentationFor(nextVerificationStatus, draft);
  return draft;
}

const SPOOF_PATTERNS: RegExp[] = [
  /\b(i\s+am|we\s+are|this\s+(content|answer|explanation)\s+is)\s+verified\b/i,
  /\balready\s+verified\b/i,
  /\bself[-_]?claimed\s+verified\b/i,
  /模型自称\s*verified/i,
  /(?:内容|讲解|答案)?已核验/,
  /权威讲解/,
  /可作为正式评分依据/,
  /\bauthority\s*[:=]\s*["']?verified["']?/i,
  /\bverificationStatus\s*[:=]\s*["']?verified["']?/i,
  /\bpeer[_-]?model[_-]?upvote\b/i,
  /\banother\s+model\s+(agrees|likes|upvoted|says\s+ok)\b/i,
  /\bsecond\s+llm\s+(agrees|upvote|looks\s+good)\b/i,
];

function collectText(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectText(v, out, depth + 1);
    }
  }
}

/** Rejects model self-claim verified / fake scoring credentials in payload. */
export function assertNotAuthoritySpoof(modelTextOrExtras: unknown): void {
  const parts: string[] = [];
  collectText(modelTextOrExtras, parts);
  const blob = parts.join("\n");
  for (const re of SPOOF_PATTERNS) {
    if (re.test(blob)) {
      throw new Error(
        `authority spoof rejected: model self-claim / fake credentials matched ${re}`,
      );
    }
  }
}

/**
 * 流式未完成JSON不执行动作；完整已检查块才可交互.
 */
export function denyIncompleteStreamActions(input: {
  jsonComplete: boolean;
  blockValidationComplete: boolean;
}): { allowActions: boolean; reason: string } {
  if (!input.jsonComplete) {
    return {
      allowActions: false,
      reason: "stream JSON incomplete — actions denied",
    };
  }
  if (!input.blockValidationComplete) {
    return {
      allowActions: false,
      reason: "block validation incomplete — actions denied",
    };
  }
  return {
    allowActions: true,
    reason: "complete checked block — actions allowed",
  };
}

/**
 * 每次读取/继续重新检查删除或隐私排除.
 */
export function recheckPrivacyFreshness(input: {
  previouslyVerified: boolean;
  excludedSourceIds: string[];
  referencedSourceIds: string[];
  epochMatched: boolean;
}): { stillValid: boolean; nextStatus?: "stale" | "needs_check" } {
  if (!input.epochMatched) {
    return {
      stillValid: false,
      nextStatus: input.previouslyVerified ? "stale" : "needs_check",
    };
  }
  const excluded = new Set(input.excludedSourceIds);
  const hit = input.referencedSourceIds.some((id) => excluded.has(id));
  if (hit) {
    return {
      stillValid: false,
      nextStatus: input.previouslyVerified ? "stale" : "needs_check",
    };
  }
  return { stillValid: true };
}

/** Test helper: expose spoof patterns without granting authority. */
export function authoritySpoofPatterns(): readonly RegExp[] {
  return SPOOF_PATTERNS;
}

/** Structure layers set (for callers that need to label). */
export function isStructureLayer(id: ValidationLayerId): boolean {
  return STRUCTURE_LAYERS.has(id);
}
