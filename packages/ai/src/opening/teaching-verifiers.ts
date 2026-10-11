/**
 * V2-09 teaching verifiers — run layered checks; emit domain ValidationReport.
 * Uses classifyClaimSupport / pack / coverage — does NOT fork chunk loaders.
 * Tool timeout → LayerOutcome unknown (never coerced to pass/fail).
 * Peer-model upvote is NOT an accepted independent proof.
 */
import type { ActivitySpecPublishInput, ProviderOutput, SourceChunk } from "@aistudy/contracts";
import {
  ALLOWED_TEACHING_BLOCK_TYPES,
  buildValidationReport,
  denyIncompleteStreamActions,
  mayPublishVerified,
  type LayerResult,
  type NextVerificationStatus,
  type ValidationReport,
} from "@aistudy/domain";
import {
  assembleTeachingEvidencePack,
  classifyClaimSupport,
  type TeachingEvidencePack,
} from "./teaching-evidence";

export type VerifyTeachingKeyClaim = {
  claimId: string;
  text: string;
  citedChunkIds: string[];
  isCoreConclusion: boolean;
};

export type VerifyTeachingInput = {
  activityId: string;
  publishInput: ActivitySpecPublishInput;
  /** Library block contents for claim/injection scans (answer_key still server-side). */
  blocks: Array<{
    id: string;
    type: string;
    role: string;
    content: Record<string, unknown>;
  }>;
  pack: TeachingEvidencePack;
  /** Optional key claims extracted from teach/example blocks. */
  keyClaims: VerifyTeachingKeyClaim[];
  /** Optional tool runner; timeout must surface as unknown. */
  tools?: {
    checkFormula?: (
      latex: string,
    ) => Promise<{ ok: boolean } | { unknown: true; reason: string }>;
  };
  modelExtras?: unknown;
};

export type VerifyTutorOutputInput = {
  output: ProviderOutput;
  pack: TeachingEvidencePack;
  jsonComplete: boolean;
};

const ALLOWED_TYPE_SET = new Set<string>(ALLOWED_TEACHING_BLOCK_TYPES);

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior)\s+instructions?/i,
  /system\s*:\s*you\s+are\s+now/i,
  /<\s*script\b/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /\\write18\b/i,
  /\\input\s*\{/i,
  /\\include\s*\{/i,
  /\\catcode\b/i,
  /\]\]>\s*<script/i,
];

function textFromContent(content: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const v of Object.values(content)) {
    if (typeof v === "string") parts.push(v);
    else if (v && typeof v === "object") {
      try {
        parts.push(JSON.stringify(v));
      } catch {
        /* ignore */
      }
    }
  }
  return parts.join("\n");
}

function collectBlockTexts(
  blocks: VerifyTeachingInput["blocks"],
): string {
  return blocks.map((b) => textFromContent(b.content)).join("\n");
}

/**
 * Material instruction injection; latex/URL injection patterns → fail findings.
 */
export function scanInjectionRisks(text: string): LayerResult {
  const hits: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) hits.push(re.source);
  }
  if (hits.length > 0) {
    return {
      layer: "schema",
      outcome: "fail",
      reason: `injection risk findings: ${hits.join("; ")}`,
      details: { patterns: hits },
    };
  }
  return {
    layer: "schema",
    outcome: "pass",
    reason: "no injection patterns detected",
  };
}

/**
 * 模型自称 verified → fail (does not grant verified).
 * Peer-model upvote / second LLM "looks good" is rejected as proof.
 */
export function detectAuthoritySpoof(textOrExtras: unknown): LayerResult {
  const parts: string[] = [];
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 6) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        parts.push(k);
        walk(v, depth + 1);
      }
    }
  };
  walk(textOrExtras);
  const blob = parts.join("\n");

  const spoofChecks: Array<{ re: RegExp; label: string }> = [
    {
      re: /\b(i\s+am|we\s+are|this\s+(content|answer|explanation)\s+is)\s+verified\b/i,
      label: "self-claimed verified",
    },
    { re: /\balready\s+verified\b/i, label: "already verified claim" },
    { re: /已核验/, label: "chinese verified self-claim" },
    { re: /权威讲解/, label: "authoritative teaching claim" },
    {
      re: /\bverificationStatus\s*[:=]\s*["']?verified["']?/i,
      label: "verificationStatus=verified spoof",
    },
    {
      re: /\bpeer[_-]?model[_-]?upvote\b/i,
      label: "peer-model upvote (rejected proof)",
    },
    {
      re: /\banother\s+model\s+(agrees|likes|upvoted|says\s+ok)\b/i,
      label: "another model agreement (rejected proof)",
    },
    {
      re: /\bsecond\s+llm\s+(agrees|upvote|looks\s+good)\b/i,
      label: "second LLM upvote (rejected proof)",
    },
  ];

  for (const { re, label } of spoofChecks) {
    if (re.test(blob)) {
      return {
        layer: "claim_support",
        outcome: "fail",
        reason: `authority spoof: ${label}`,
        details: { spoof: label },
      };
    }
  }

  return {
    layer: "claim_support",
    outcome: "pass",
    reason: "no authority spoof detected",
  };
}

function verifySchemaLayer(input: VerifyTeachingInput): LayerResult {
  const { publishInput, blocks } = input;
  if (!publishInput.activityId || publishInput.activityId.length === 0) {
    return {
      layer: "schema",
      outcome: "fail",
      reason: "publishInput.activityId missing",
    };
  }
  if (!Array.isArray(publishInput.blockOrder)) {
    return {
      layer: "schema",
      outcome: "fail",
      reason: "publishInput.blockOrder missing",
    };
  }
  if (publishInput.blockOrder.length === 0) {
    return {
      layer: "schema",
      outcome: "fail",
      reason: "blockOrder empty — structure incomplete",
    };
  }

  for (const ref of publishInput.blockOrder) {
    if (!ref.blockId || typeof ref.position !== "number") {
      return {
        layer: "schema",
        outcome: "fail",
        reason: "blockOrder entry missing blockId/position",
      };
    }
  }

  for (const block of blocks) {
    const mapped = block.type;
    if (
      mapped &&
      !ALLOWED_TYPE_SET.has(mapped) &&
      mapped !== "matrix-viz" &&
      mapped !== "matrix_viz"
    ) {
      // Unknown types are a soft structure note — fail only clearly hostile types
      if (/script|iframe|html|js/i.test(mapped)) {
        return {
          layer: "schema",
          outcome: "fail",
          reason: `disallowed block type: ${mapped}`,
        };
      }
    }
  }

  const injection = scanInjectionRisks(collectBlockTexts(blocks));
  if (injection.outcome === "fail") {
    return injection;
  }

  return {
    layer: "schema",
    outcome: "pass",
    reason: "ActivitySpec shape + injection scan ok",
  };
}

function verifySourceIdentity(input: VerifyTeachingInput): LayerResult {
  const packChunkIds = new Set(input.pack.chunks.map((c) => c.id));
  const packSourceIds = new Set(input.pack.chunks.map((c) => c.sourceId));
  for (const a of input.pack.anchors) {
    packChunkIds.add(a.chunkId);
    packSourceIds.add(a.sourceId);
  }

  const refs = input.publishInput.sourceRefs ?? [];
  const bad: string[] = [];
  for (const ref of refs) {
    if (ref.chunkId && !packChunkIds.has(ref.chunkId)) {
      // chunk id cited but not in pack — identity fail only when pack non-empty
      // or when claim cites it; here: sourceRefs with chunkId must be in pack
      bad.push(`chunk:${ref.chunkId}`);
    }
    if (
      input.pack.chunks.length > 0 &&
      ref.sourceId &&
      !packSourceIds.has(ref.sourceId) &&
      !input.pack.boundaries.privacyExcludedSourceIds.includes(ref.sourceId)
    ) {
      // source not in pack when pack has materials — identity warning
      // Keep as fail only if chunkId also missing from pack and was required
      if (ref.chunkId) bad.push(`source:${ref.sourceId}`);
    }
  }

  // Cited claims' chunk ids must be in pack when present
  for (const claim of input.keyClaims) {
    for (const id of claim.citedChunkIds) {
      if (!packChunkIds.has(id)) {
        bad.push(`claim-cite:${id}`);
      }
    }
  }

  if (bad.length > 0 && input.pack.chunks.length > 0) {
    return {
      layer: "source_identity",
      outcome: "fail",
      reason: `source identity mismatch: ${bad.slice(0, 8).join(",")}`,
      details: { bad },
    };
  }

  // Version pin: anchors carry sourceVersion; if pack empty with refs that need materials
  if (input.pack.boundaries.noMaterials && refs.length > 0) {
    return {
      layer: "source_identity",
      outcome: "fail",
      reason: "no materials in pack but sourceRefs present",
    };
  }

  return {
    layer: "source_identity",
    outcome: "pass",
    reason: "cited chunks/sources are in pack (version-pinned anchors)",
  };
}

function extractClaimsFromBlocks(
  blocks: VerifyTeachingInput["blocks"],
): VerifyTeachingKeyClaim[] {
  const out: VerifyTeachingKeyClaim[] = [];
  for (const block of blocks) {
    if (block.role !== "teach" && block.role !== "example") continue;
    const text =
      (typeof block.content.text === "string" && block.content.text) ||
      (typeof block.content.body === "string" && block.content.body) ||
      textFromContent(block.content);
    if (!text.trim()) continue;
    const cited =
      (Array.isArray(block.content.citedChunkIds) &&
        (block.content.citedChunkIds as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )) ||
      [];
    out.push({
      claimId: `auto:${block.id}`,
      text: text.slice(0, 2000),
      citedChunkIds: cited,
      isCoreConclusion: block.role === "teach",
    });
  }
  return out;
}

function verifyClaimSupport(input: VerifyTeachingInput): LayerResult {
  const spoof = detectAuthoritySpoof(input.modelExtras ?? {});
  // Spoof on claim layer — if fail, fact fails
  if (spoof.outcome === "fail" && spoof.reason.startsWith("authority spoof")) {
    return spoof;
  }

  let claims = input.keyClaims;
  if (claims.length === 0) {
    claims = extractClaimsFromBlocks(input.blocks);
  }

  if (claims.length === 0) {
    return {
      layer: "claim_support",
      outcome: "fail",
      reason: "no key claims to verify — refusing vacuous fact pass",
      details: { vacuous: true },
    };
  }

  // Coverage conflict / uncovered on pack rows for core conclusions
  const conflictRows = input.pack.coverage.filter((r) => r.status === "conflict");
  const uncoveredRows = input.pack.coverage.filter(
    (r) => r.status === "uncovered",
  );

  const coreFails: Array<Record<string, unknown>> = [];
  for (const claim of claims) {
    const support = classifyClaimSupport({
      claimText: claim.text,
      citedChunkIds: claim.citedChunkIds,
      pack: input.pack,
    });

    if (claim.isCoreConclusion) {
      if (!support.okForMaterialClaim || support.kind === "uncovered") {
        coreFails.push({
          claimId: claim.claimId,
          kind: support.kind,
          reason: support.reason,
          okForMaterialClaim: support.okForMaterialClaim,
        });
      }
      if (support.kind === "conflict") {
        coreFails.push({
          claimId: claim.claimId,
          kind: "conflict",
          reason: support.reason,
          unresolvedConflict: true,
        });
      }
    }
  }

  if (conflictRows.length > 0) {
    return {
      layer: "claim_support",
      outcome: "fail",
      reason: `unresolved conflict on coverage (${conflictRows.length} row(s))`,
      details: {
        unresolvedConflict: true,
        coverageStatus: "conflict",
        conflictConditionIds: conflictRows.map((r) => r.conditionId),
      },
    };
  }

  // Core uncovered via coverage table
  const coreUncoveredCoverage = uncoveredRows.length > 0 && claims.some((c) => c.isCoreConclusion);
  if (coreFails.length > 0 || coreUncoveredCoverage) {
    return {
      layer: "claim_support",
      outcome: "fail",
      reason:
        coreFails[0] && typeof coreFails[0].reason === "string"
          ? String(coreFails[0].reason)
          : "core claim uncovered or unsupported (citation id ≠ support)",
      details: {
        coreFails,
        uncoveredConditionIds: uncoveredRows.map((r) => r.conditionId),
        coverageStatus: coreFails.some((f) => f.kind === "conflict")
          ? "conflict"
          : "uncovered",
      },
    };
  }

  return {
    layer: "claim_support",
    outcome: "pass",
    reason: "core claims have material support via classifyClaimSupport",
  };
}

async function verifyToolResult(input: VerifyTeachingInput): Promise<LayerResult> {
  if (!input.tools?.checkFormula) {
    return {
      layer: "tool_result",
      outcome: "skipped",
      reason: "no formula tool configured",
    };
  }

  const latexSnippets: string[] = [];
  for (const block of input.blocks) {
    if (block.type === "formula" || block.role === "teach") {
      const latex =
        (typeof block.content.latex === "string" && block.content.latex) ||
        (typeof block.content.formula === "string" && block.content.formula) ||
        null;
      if (latex) latexSnippets.push(latex);
    }
  }

  if (latexSnippets.length === 0) {
    return {
      layer: "tool_result",
      outcome: "skipped",
      reason: "no formula latex to check",
    };
  }

  for (const latex of latexSnippets) {
    let result: { ok: boolean } | { unknown: true; reason: string };
    try {
      result = await input.tools.checkFormula(latex);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|timed\s*out|ETIMEDOUT|abort/i.test(msg)) {
        return {
          layer: "tool_result",
          outcome: "unknown",
          reason: `formula tool timeout: ${msg}`,
          details: { latex },
        };
      }
      return {
        layer: "tool_result",
        outcome: "fail",
        reason: `formula tool error: ${msg}`,
        details: { latex },
      };
    }

    if ("unknown" in result && result.unknown) {
      return {
        layer: "tool_result",
        outcome: "unknown",
        reason: result.reason || "formula tool returned unknown",
        details: { latex },
      };
    }
    if ("ok" in result && !result.ok) {
      return {
        layer: "tool_result",
        outcome: "fail",
        reason: "formula check failed",
        details: { latex },
      };
    }
  }

  return {
    layer: "tool_result",
    outcome: "pass",
    reason: "formula tool checks passed",
  };
}

function verifyActionPermission(input: VerifyTeachingInput): LayerResult {
  // Content publish path: blocks are complete library payloads → allow
  const fence = denyIncompleteStreamActions({
    jsonComplete: true,
    blockValidationComplete: input.blocks.length > 0 || input.publishInput.blockOrder.length > 0,
  });
  return {
    layer: "action_permission",
    outcome: fence.allowActions ? "pass" : "fail",
    reason: fence.reason,
  };
}

/**
 * Runs L1–L5; uses classifyClaimSupport; conflict/uncovered on core → fact fail;
 * checkFormula timeout → layer tool_result unknown (not pass/fail);
 * another model "upvote" is NOT an accepted tool — rejected alternative.
 */
export async function verifyTeachingContent(
  input: VerifyTeachingInput,
): Promise<ValidationReport> {
  const layers: LayerResult[] = [];

  layers.push(verifySchemaLayer(input));
  layers.push(verifySourceIdentity(input));
  layers.push(verifyClaimSupport(input));
  layers.push(await verifyToolResult(input));
  layers.push(verifyActionPermission(input));

  return buildValidationReport({
    activityId: input.activityId,
    layers,
  });
}

/**
 * Schema already via providerOutputSchema; add injection + incomplete-stream action deny.
 */
export function verifyTutorTurnOutput(input: VerifyTutorOutputInput): LayerResult[] {
  const results: LayerResult[] = [];

  const injection = scanInjectionRisks(input.output.text);
  // Re-tag: injection on tutor output is schema-ish for the turn
  results.push(injection);

  const spoof = detectAuthoritySpoof({
    text: input.output.text,
    candidates: input.output.candidates,
  });
  results.push(spoof);

  // Soft: cited ids that are not in pack — note on source_identity (fail if any unknown)
  const packIds = new Set(input.pack.chunks.map((c) => c.id));
  const unknownCites = input.output.citedChunkIds.filter((id) => !packIds.has(id));
  results.push({
    layer: "source_identity",
    outcome:
      unknownCites.length === 0 || input.pack.chunks.length === 0 ? "pass" : "fail",
    reason:
      unknownCites.length === 0
        ? "tutor cites are in pack or pack empty"
        : `tutor cited unknown chunk ids: ${unknownCites.join(",")}`,
    details: { unknownCites },
  });

  const fence = denyIncompleteStreamActions({
    jsonComplete: input.jsonComplete,
    blockValidationComplete: input.jsonComplete,
  });
  results.push({
    layer: "action_permission",
    outcome: fence.allowActions ? "pass" : "fail",
    reason: fence.reason,
  });

  return results;
}

/** Env flag: teachingValidation.enabled / OPENING_TEACHING_VALIDATION_ENABLED */
export function isTeachingValidationEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw =
    env.OPENING_TEACHING_VALIDATION_ENABLED ??
    env.TEACHING_VALIDATION_ENABLED ??
    "";
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

export type TeachingValidationPromotion = {
  nextVerificationStatus: NextVerificationStatus;
  nextGenerateStatus?: "ready" | "needs_check" | "failed" | "unknown" | "stale";
  report: ValidationReport;
};

export type CreateTeachingValidationAfterPublishOptions = {
  loadChunks: (
    scope: { workspaceId: string; ownerUserId: string },
    sourceIds: string[],
  ) => Promise<SourceChunk[]>;
  loadBlocks?: (
    scope: { workspaceId: string; ownerUserId: string },
    publishInput: ActivitySpecPublishInput,
  ) => Promise<VerifyTeachingInput["blocks"]>;
  tools?: VerifyTeachingInput["tools"];
};

/**
 * Thin V2-09 factory for compile-teaching-unit verifyAfterPublish.
 * Assembles pack via existing evidence helper — does not fork chunk loaders.
 * Without teach/example blocks or keyClaims, fact layer refuses vacuous pass
 * (may land structure_ok, never false verified).
 */
export function createTeachingValidationAfterPublish(
  options: CreateTeachingValidationAfterPublishOptions,
) {
  return async function verifyAfterPublish(
    scope: { workspaceId: string; ownerUserId: string },
    input: {
      activityId: string;
      publishInput: ActivitySpecPublishInput;
      providerOutput: ProviderOutput | null;
    },
  ): Promise<TeachingValidationPromotion | null> {
    const sourceIds = [
      ...new Set(
        (input.publishInput.sourceRefs ?? [])
          .map((r) => r.sourceId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const chunks =
      sourceIds.length > 0 ? await options.loadChunks(scope, sourceIds) : [];
    const pack = assembleTeachingEvidencePack({
      chunks,
      query: "teaching validation",
      maxCharacters: 8_000,
      allowlistSourceIds: sourceIds.length > 0 ? sourceIds : undefined,
    });
    const blocks = options.loadBlocks
      ? await options.loadBlocks(scope, input.publishInput)
      : [];

    const report = await verifyTeachingContent({
      activityId: input.activityId,
      publishInput: input.publishInput,
      blocks,
      pack,
      keyClaims: [],
      tools: options.tools,
      modelExtras: input.providerOutput ?? undefined,
    });

    return {
      nextVerificationStatus: report.nextVerificationStatus,
      nextGenerateStatus:
        report.nextVerificationStatus === "verified" && mayPublishVerified(report)
          ? "ready"
          : undefined,
      report,
    };
  };
}

