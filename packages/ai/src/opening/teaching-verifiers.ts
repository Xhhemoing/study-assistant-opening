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
  /** Optional additional claims; persisted blocks are always checked as well. */
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
    // Formula correctness belongs to the formula tool, not prose overlap.
    if (block.type === "formula" || block.type === "math") continue;
    if (block.role !== "teach" && block.role !== "example" && block.role !== "answer_key") continue;
    const text =
      (typeof block.content.text === "string" && block.content.text) ||
      (typeof block.content.body === "string" && block.content.body) ||
      (typeof block.content.answer === "string" && block.content.answer) ||
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
      isCoreConclusion: block.role === "teach" || block.role === "answer_key",
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

  // Additional caller-supplied claims must not hide an unsupported answer key
  // or another persisted block from the automatic checks.
  const claims = [...input.keyClaims, ...extractClaimsFromBlocks(input.blocks)];

  if (claims.length === 0) {
    if (input.blocks.some((block) => block.type === "formula" || block.type === "math")) {
      return {
        layer: "claim_support",
        outcome: "unknown",
        reason: "formula content requires independent factual review; prose overlap does not verify mathematics",
      };
    }
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
    outcome: "unknown",
    reason: "candidate material links found; lexical overlap cannot verify factual claims or authorize formal scoring",
    details: { requiresIndependentReview: true },
  };
}

const EQUATION_ROW_ENVS = new Set([
  "align", "align*", "aligned", "alignat", "alignat*", "alignedat",
  "xalignat", "xalignat*", "xxalignat", "flalign", "flalign*",
  "gather", "gather*", "gathered", "eqnarray", "eqnarray*",
  "equation", "equation*", "split", "array",
]);

const WRAPPED_SINGLE_EQUATION_ENVS = new Set(["multline", "multline*"]);

const CASES_ENVS = new Set(["cases", "cases*", "dcases", "dcases*", "rcases", "rcases*"]);

const ARG_SKIP_ENVS = new Set(["array", "alignat", "alignat*", "alignedat", "xalignat", "xalignat*", "xxalignat"]);

const OPTIONAL_POS_ENVS = new Set([
  "aligned", "gathered", "alignedat", "array",
  "matrix*", "pmatrix*", "bmatrix*", "Bmatrix*", "vmatrix*", "Vmatrix*",
]);

const INTERTEXT_BREAK = "\0INTERTEXT_BREAK\0";

function readBalancedGroup(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function readBalancedBracket(text: string, openIndex: number): number {
  let braceDepth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "]" && braceDepth === 0) return i + 1;
  }
  return -1;
}

function stripOuterMathDelimiters(raw: string): string {
  let text = raw.trim();
  while (text) {
    if (text.startsWith("$$") && text.endsWith("$$") && text.length >= 4 && !text.slice(2, -2).includes("$$")) {
      text = text.slice(2, -2).trim();
      continue;
    }
    if (text.startsWith("\\[") && text.endsWith("\\]") && text.length >= 4 && !text.slice(2, -2).includes("\\]")) {
      text = text.slice(2, -2).trim();
      continue;
    }
    if (text.startsWith("\\(") && text.endsWith("\\)") && text.length >= 4 && !text.slice(2, -2).includes("\\)")) {
      text = text.slice(2, -2).trim();
      continue;
    }
    if (text.startsWith("$") && text.endsWith("$") && text.length >= 2 && !text.slice(1, -1).includes("$")) {
      text = text.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return text;
}

function matchEnvTag(text: string, index: number, kind: "begin" | "end"): { env: string; endIndex: number } | null {
  const prefix = `\\${kind}{`;
  if (!text.startsWith(prefix, index)) return null;
  const close = text.indexOf("}", index + prefix.length);
  if (close < 0) return null;
  const env = text.slice(index + prefix.length, close).trim();
  return env ? { env, endIndex: close + 1 } : null;
}

function findMatchingEnvEnd(text: string, openIndex: number): { env: string; bodyStart: number; bodyEnd: number; afterEnd: number } | null {
  const open = matchEnvTag(text, openIndex, "begin");
  if (!open) return null;
  let bodyStart = open.endIndex;
  while (bodyStart < text.length && /\s/.test(text[bodyStart]!)) bodyStart++;
  if (OPTIONAL_POS_ENVS.has(open.env) && text[bodyStart] === "[") {
    const bracketEnd = readBalancedBracket(text, bodyStart);
    if (bracketEnd > 0 && /^\[\s*[tbclr]\s*\]$/.test(text.slice(bodyStart, bracketEnd))) {
      bodyStart = bracketEnd;
      while (bodyStart < text.length && /\s/.test(text[bodyStart]!)) bodyStart++;
    }
  }
  if (ARG_SKIP_ENVS.has(open.env) && text[bodyStart] === "{") {
    const argEnd = readBalancedGroup(text, bodyStart);
    if (argEnd > 0) bodyStart = argEnd;
  }
  let envDepth = 1;
  for (let i = bodyStart; i < text.length; i++) {
    if (text[i] === "\\") {
      const nestedOpen = matchEnvTag(text, i, "begin");
      if (nestedOpen) {
        envDepth++;
        i = nestedOpen.endIndex - 1;
        continue;
      }
      const nestedClose = matchEnvTag(text, i, "end");
      if (nestedClose) {
        envDepth--;
        if (envDepth === 0) {
          return { env: open.env, bodyStart, bodyEnd: i, afterEnd: nestedClose.endIndex };
        }
        i = nestedClose.endIndex - 1;
        continue;
      }
      if (i + 1 < text.length) i++;
    }
  }
  return null;
}

function splitTopLevelRows(text: string): { rows: string[]; hasIntertext: boolean } {
  const rows: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let envDepth = 0;
  let hasIntertext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\r" || ch === "\n") {
      if (braceDepth === 0 && envDepth === 0) {
        rows.push(text.slice(start, i));
        if (ch === "\r" && text[i + 1] === "\n") i++;
        start = i + 1;
      }
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (ch !== "\\") continue;
    if (text[i + 1] === "\\") {
      if (braceDepth === 0 && envDepth === 0) {
        rows.push(text.slice(start, i));
        let next = i + 2;
        if (text[next] === "*") next++;
        const dimMatch = /^[ \t]*\[\s*-?(?:\d+(?:\.\d+)?|\.\d+|\\[A-Za-z]+)\s*(?:pt|px|em|ex|rem|mm|cm|in|pc|bp|dd|cc|sp|mu|\\[A-Za-z]+)\s*\]/i.exec(text.slice(next));
        if (dimMatch) next += dimMatch[0].length;
        start = next;
        i = next - 1;
      } else {
        i++;
      }
      continue;
    }
    const open = matchEnvTag(text, i, "begin");
    if (open) {
      envDepth++;
      i = open.endIndex - 1;
      continue;
    }
    const close = matchEnvTag(text, i, "end");
    if (close) {
      envDepth = Math.max(0, envDepth - 1);
      i = close.endIndex - 1;
      continue;
    }
    if (braceDepth === 0 && envDepth === 0) {
      const crMatch = /^\\cr(?![A-Za-z])/.exec(text.slice(i));
      if (crMatch) {
        rows.push(text.slice(start, i));
        start = i + crMatch[0].length;
        i = start - 1;
        continue;
      }
      const interMatch = /^\\(?:short)?intertext(?![A-Za-z])\s*\{/.exec(text.slice(i));
      if (interMatch) {
        const groupEnd = readBalancedGroup(text, i + interMatch[0].length - 1);
        if (groupEnd > 0) {
          rows.push(text.slice(start, i), INTERTEXT_BREAK);
          hasIntertext = true;
          start = groupEnd;
          i = groupEnd - 1;
          continue;
        }
      }
    }
    if (i + 1 < text.length && !/[A-Za-z]/.test(text[i + 1]!)) i++;
  }
  rows.push(text.slice(start));
  return { rows, hasIntertext };
}

function splitTopLevelAmpersands(row: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let envDepth = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === "\\") {
      const open = matchEnvTag(row, i, "begin");
      if (open) {
        envDepth++;
        i = open.endIndex - 1;
        continue;
      }
      const close = matchEnvTag(row, i, "end");
      if (close) {
        envDepth = Math.max(0, envDepth - 1);
        i = close.endIndex - 1;
        continue;
      }
      if (i + 1 < row.length && !/[A-Za-z]/.test(row[i + 1]!)) i++;
      continue;
    }
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "&" && braceDepth === 0 && envDepth === 0) {
      cells.push(row.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(row.slice(start));
  return cells;
}

function stripBraceArgMacros(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      const macroMatch = /^\\(?:tag\*?|label|cline)(?![A-Za-z])\s*\{/.exec(text.slice(i));
      if (macroMatch) {
        const groupEnd = readBalancedGroup(text, i + macroMatch[0].length - 1);
        if (groupEnd > 0) {
          i = groupEnd - 1;
          continue;
        }
      }
    }
    out += text[i]!;
  }
  return out;
}

function cleanEquationClause(raw: string): string {
  let text = stripOuterMathDelimiters(raw);
  text = stripBraceArgMacros(text);
  text = text
    .replace(/\\(?:notag|nonumber|hline|toprule|midrule|bottomrule|displaystyle|textstyle|scriptstyle|scriptscriptstyle)(?![A-Za-z])/g, " ")
    .replace(/\\left\s*\(/g, "(")
    .replace(/\\right\s*\)/g, ")")
    .replace(/\\(?:quad|qquad|enspace|thinspace)(?![A-Za-z])/g, " ")
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;，；]+/, "")
    .replace(/[.,;。，；]+$/, "")
    .trim();
  return text;
}

function stripLeadingHorizontalSpacing(text: string): string {
  return text.replace(/^(?:\s|\\(?:quad|qquad|enspace|thinspace)(?![A-Za-z])|\\[,;:! ])+/, "");
}

function endsWithOperatorOrEquals(text: string): boolean {
  return /(?:=|\\times|\\div|\\cdot|\\pm|\\mp|[+\-*/×÷−±])\s*$/.test(text);
}

function startsWithEquals(text: string): boolean {
  return /^\s*=/.test(stripLeadingHorizontalSpacing(text));
}

function startsWithContinuationOperator(text: string): boolean {
  return /^\s*(?:\\times|\\div|\\cdot|\\pm|\\mp|[+\-*/×÷−±])/.test(stripLeadingHorizontalSpacing(text));
}

function looksLikeMathExpression(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /[:：]$/.test(trimmed)) return false;
  const withoutTextMacros = trimmed
    .replace(/\\(?:text|textbf|textit|textrm|textsf|texttt|mbox|hbox)\s*\{[^{}]*\}/g, " ")
    .trim();
  if (!withoutTextMacros) return false;
  return /(?:[+\-*/×÷−^_()]|\\(?:frac|dfrac|tfrac|times|div|cdot))/.test(withoutTextMacros)
    || /^-?(?:\d+(?:\.\d+)?|\.\d+|[A-Za-z])$/.test(withoutTextMacros);
}

function isNewColumnEquation(cells: string[], startIndex: number): boolean {
  const first = stripLeadingHorizontalSpacing(cells[startIndex]!);
  if (first.includes("=")) return true;
  for (let j = startIndex + 1; j < cells.length; j++) {
    const next = stripLeadingHorizontalSpacing(cells[j]!);
    if (startsWithEquals(next) || next.includes("=")) return true;
    if (!startsWithContinuationOperator(next) && !endsWithOperatorOrEquals(cells[j - 1]!)) break;
  }
  return false;
}

function mergeAlignedCells(cells: string[]): string[] {
  if (cells.length <= 1) return cells;
  const nonEmpty = cells.map(cell => cell.trim()).filter(Boolean);
  const groups: string[] = [];
  let current = "";
  for (let i = 0; i < nonEmpty.length; i++) {
    const cell = nonEmpty[i]!;
    const stripped = stripLeadingHorizontalSpacing(cell);
    if (!current) {
      current = cell;
      continue;
    }
    if (endsWithOperatorOrEquals(current) || startsWithEquals(stripped)) {
      current = `${current} ${cell}`;
      continue;
    }
    if (startsWithContinuationOperator(stripped)) {
      if (!current.includes("=")) {
        current = `${current} ${cell}`;
        continue;
      }
      const isSignedNewEquation = /^[+\-−]/.test(stripped) && isNewColumnEquation(nonEmpty, i);
      if (!isSignedNewEquation) {
        current = `${current} ${cell}`;
        continue;
      }
    }
    groups.push(current);
    current = cell;
  }
  if (current) groups.push(current);
  return groups;
}

function shouldRejoinRowClause(prev: string, next: string): boolean {
  if (endsWithOperatorOrEquals(prev)) return true;
  if (startsWithEquals(next)) return prev.includes("=") || looksLikeMathExpression(prev);
  if (startsWithContinuationOperator(next)) {
    if (prev.includes("=")) return !next.includes("=");
    return looksLikeMathExpression(prev);
  }
  return false;
}

function isExtractableEnv(env: string): boolean {
  return EQUATION_ROW_ENVS.has(env) || WRAPPED_SINGLE_EQUATION_ENVS.has(env) || CASES_ENVS.has(env);
}

function extractFromLatexFragment(raw: string, out: string[]): boolean {
  const text = stripOuterMathDelimiters(raw);
  if (!text) return false;
  if (text.startsWith("\\begin{")) {
    const outer = findMatchingEnvEnd(text, 0);
    if (outer && outer.afterEnd === text.length) {
      const body = text.slice(outer.bodyStart, outer.bodyEnd);
      if (CASES_ENVS.has(outer.env)) {
        const { rows } = splitTopLevelRows(body);
        for (const branch of rows) {
          if (!branch.trim() || branch === INTERTEXT_BREAK) continue;
          const cells = splitTopLevelAmpersands(branch);
          for (const cell of cells) {
            const cleaned = cleanEquationClause(cell);
            if (cleaned.includes("=")) out.push(cleaned);
          }
        }
        return true;
      }
      if (WRAPPED_SINGLE_EQUATION_ENVS.has(outer.env)) {
        const { rows } = splitTopLevelRows(body);
        const joined = cleanEquationClause(rows.filter(r => r !== INTERTEXT_BREAK).map(r => r.trim()).filter(Boolean).join(" "));
        if (!joined) return false;
        if (joined.includes("=")) {
          out.push(joined);
          return false;
        }
        return true;
      }
      if (EQUATION_ROW_ENVS.has(outer.env)) {
        return extractFromLatexFragment(body, out);
      }
    }
  }
  const { rows, hasIntertext } = splitTopLevelRows(text);
  let hasNonEquationContent = hasIntertext;
  let pendingRowClause: string | null = null;
  const flushPending = () => {
    if (!pendingRowClause) return;
    if (pendingRowClause.includes("=")) out.push(pendingRowClause);
    else hasNonEquationContent = true;
    pendingRowClause = null;
  };
  for (const row of rows) {
    if (row === INTERTEXT_BREAK) {
      flushPending();
      hasNonEquationContent = true;
      continue;
    }
    if (!row.trim()) continue;
    const groups = mergeAlignedCells(splitTopLevelAmpersands(row));
    const singleGroupRow = groups.length === 1;
    if (!singleGroupRow) flushPending();
    for (const group of groups) {
      const outerParts: string[] = [];
      let outerStart = 0;
      let cursor = 0;
      let extractedInner = false;
      while (cursor < group.length) {
        const innerStart = group.indexOf("\\begin{", cursor);
        if (innerStart < 0) break;
        const innerEnv = findMatchingEnvEnd(group, innerStart);
        if (!innerEnv) break;
        if (isExtractableEnv(innerEnv.env)) {
          extractedInner = true;
          hasNonEquationContent = true;
          outerParts.push(group.slice(outerStart, innerStart));
          extractFromLatexFragment(group.slice(innerStart, innerEnv.afterEnd), out);
          outerStart = innerEnv.afterEnd;
          cursor = innerEnv.afterEnd;
        } else {
          cursor = innerStart + 7;
        }
      }
      if (extractedInner) {
        flushPending();
        outerParts.push(group.slice(outerStart));
        for (const part of outerParts) {
          const cleanedOuter = cleanEquationClause(part);
          if (!cleanedOuter) continue;
          if (cleanedOuter.includes("=") && !/^\s*=|=\s*$/.test(cleanedOuter)) out.push(cleanedOuter);
          else hasNonEquationContent = true;
        }
        continue;
      }
      const cleaned = cleanEquationClause(group);
      if (!cleaned) continue;
      if (singleGroupRow) {
        if (pendingRowClause && shouldRejoinRowClause(pendingRowClause, cleaned)) {
          pendingRowClause = `${pendingRowClause} ${cleaned}`.trim();
        } else {
          flushPending();
          pendingRowClause = cleaned;
        }
      } else if (cleaned.includes("=")) {
        out.push(cleaned);
      } else {
        hasNonEquationContent = true;
      }
    }
  }
  flushPending();
  return hasNonEquationContent;
}

function extractFormulaSnippets(formula: string): string[] {
  const equations: string[] = [];
  const hasNonEquationContent = extractFromLatexFragment(formula, equations);
  if (equations.length === 0 || hasNonEquationContent) equations.push(formula);
  return [...new Set(equations)];
}

const CLAUSE_SPLIT_MACROS = new Set([
  "implies", "impliedby", "iff", "Rightarrow", "Leftarrow", "Leftrightarrow",
  "Longrightarrow", "Longleftrightarrow", "Longleftarrow",
  "to", "rightarrow", "leftarrow", "leftrightarrow", "mapsto", "therefore", "because",
  "le", "leq", "leqslant", "ge", "geq", "geqslant", "neq", "ne",
  "approx", "sim", "simeq", "cong", "equiv", "propto",
]);

const TEXT_MACRO_NAMES = new Set(["text", "mtext", "textbf", "textit", "textrm", "textsf", "texttt", "mbox", "hbox"]);

const PROSE_CONNECTIVE_WORD = /^(?:and|or|when|where|if|then|so|for|with|hence|thus|since|as|therefore|because|but|otherwise|while)$/i;

const CJK_CLAUSE_CONNECTIVE = /^(?:所以|因此|于是|从而|进而|并且|而且|但是|然而|如果|因为|由于|其中|此时|例如|比如|验证|检查|步骤|且|或|和|与|即|故|则|若|当|得|由)$/;

function isProseTextMacroBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  // Split only on pure clause punctuation / explicit prose connectives so units
  // (e.g. \text{厘米}, \text{square cm}, \text{(cm)}, \text{in}) stay attached.
  const stripped = trimmed.replace(/[,;，；。:：]/g, " ").trim();
  if (!stripped) return true;
  const tokens = stripped.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(token =>
    PROSE_CONNECTIVE_WORD.test(token) || CJK_CLAUSE_CONNECTIVE.test(token),
  );
}

function splitMultiClauseFormula(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let envDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      const open = matchEnvTag(text, i, "begin");
      if (open) {
        envDepth++;
        i = open.endIndex - 1;
        continue;
      }
      const close = matchEnvTag(text, i, "end");
      if (close) {
        envDepth = Math.max(0, envDepth - 1);
        i = close.endIndex - 1;
        continue;
      }
      const cmdMatch = /^\\([A-Za-z]+)/.exec(text.slice(i));
      if (cmdMatch) {
        const cmd = cmdMatch[1]!;
        const afterCmd = i + 1 + cmd.length;
        if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && envDepth === 0) {
          if (CLAUSE_SPLIT_MACROS.has(cmd)) {
            clauses.push(text.slice(start, i));
            start = afterCmd;
            i = afterCmd - 1;
            continue;
          }
          if (TEXT_MACRO_NAMES.has(cmd) || cmd === "mathrm") {
            let argPos = afterCmd;
            while (argPos < text.length && /\s/.test(text[argPos]!)) argPos++;
            if (text[argPos] === "{") {
              const groupEnd = readBalancedGroup(text, argPos);
              if (groupEnd > 0) {
                const body = text.slice(argPos + 1, groupEnd - 1);
                const shouldSplit = cmd === "mathrm"
                  ? PROSE_CONNECTIVE_WORD.test(body.trim())
                  : isProseTextMacroBody(body);
                if (shouldSplit) {
                  clauses.push(text.slice(start, i));
                  start = groupEnd;
                  i = groupEnd - 1;
                  continue;
                }
                i = groupEnd - 1;
                continue;
              }
            }
          }
        }
        i = afterCmd - 1;
        continue;
      }
      if (i + 1 < text.length) i++;
      continue;
    }

    if (ch === "{") { braceDepth++; continue; }
    if (ch === "}") { braceDepth = Math.max(0, braceDepth - 1); continue; }
    if (ch === "(") { parenDepth++; continue; }
    if (ch === ")") { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (ch === "[") { bracketDepth++; continue; }
    if (ch === "]") { bracketDepth = Math.max(0, bracketDepth - 1); continue; }

    if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0 || envDepth !== 0) continue;

    if (/[,;，；。<>≠≤≥≈≡⇒⇐⇔→←↔↦∴∵]/.test(ch)) {
      clauses.push(text.slice(start, i));
      if ((ch === "<" || ch === ">") && text[i + 1] === "=") i++;
      start = i + 1;
      continue;
    }

    if (ch === "!" && text[i + 1] === "=") {
      clauses.push(text.slice(start, i));
      start = i + 2;
      i++;
      continue;
    }

    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) {
      const cjkMatch = /^[\u4e00-\u9fff\u3400-\u4dbf]+/.exec(text.slice(i));
      if (cjkMatch) {
        const word = cjkMatch[0];
        const nextIndex = i + word.length;
        if (CJK_CLAUSE_CONNECTIVE.test(word)) {
          clauses.push(text.slice(start, i));
          start = nextIndex;
          i = nextIndex - 1;
          continue;
        }
        i = nextIndex - 1;
        continue;
      }
    }

    if (/[A-Za-z]/.test(ch)) {
      const prev = i > 0 ? text[i - 1]! : "";
      if (!/[A-Za-z0-9\\]/.test(prev)) {
        const wordMatch = /^[A-Za-z]+/.exec(text.slice(i));
        if (wordMatch) {
          const word = wordMatch[0];
          const nextIndex = i + word.length;
          const next = nextIndex < text.length ? text[nextIndex]! : "";
          if (PROSE_CONNECTIVE_WORD.test(word) && (!next || /[\s,;:)}\\[\]]/.test(next))) {
            clauses.push(text.slice(start, i));
            start = nextIndex;
            i = nextIndex - 1;
            continue;
          }
          i = nextIndex - 1;
        }
      }
    }
  }
  clauses.push(text.slice(start));
  return clauses.map(clause => cleanEquationClause(clause)).filter(Boolean);
}

function isCleanEqualityMember(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.includes("=")) return false;
  if (/[\u4e00-\u9fff\u3400-\u4dbf,;，；。<>≠≤≥≈≡⇒⇐⇔→←↔↦∴∵]/.test(trimmed)) return false;
  if (/\\(?:text|mtext|textbf|textit|textrm|textsf|texttt|mbox|hbox)\b/.test(trimmed)) return false;
  const cmdRe = new RegExp(`\\\\(?:${[...CLAUSE_SPLIT_MACROS].join("|")})\\b`);
  if (cmdRe.test(trimmed)) return false;
  const withoutMacros = trimmed.replace(/\\[A-Za-z]+/g, " ");
  const tokens = withoutMacros.split(/[^A-Za-z]+/).filter(Boolean);
  return !tokens.some(token => PROSE_CONNECTIVE_WORD.test(token));
}

function splitTopLevelEquals(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let envDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      const open = matchEnvTag(text, i, "begin");
      if (open) {
        envDepth++;
        i = open.endIndex - 1;
        continue;
      }
      const close = matchEnvTag(text, i, "end");
      if (close) {
        envDepth = Math.max(0, envDepth - 1);
        i = close.endIndex - 1;
        continue;
      }
      if (i + 1 < text.length && !/[A-Za-z]/.test(text[i + 1]!)) i++;
      continue;
    }
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "=" && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && envDepth === 0) {
      const prev = i > 0 ? text[i - 1]! : "";
      const next = i + 1 < text.length ? text[i + 1]! : "";
      if (prev === "<" || prev === ">" || prev === "!" || prev === "=" || prev === ":" || prev === "~"
        || next === "=" || next === "<" || next === ">") {
        continue;
      }
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

async function runSingleFormulaCheck(
  checkFormula: NonNullable<VerifyTeachingInput["tools"]>["checkFormula"],
  latex: string,
): Promise<{ outcome: "pass" } | { outcome: "fail" | "unknown"; result: LayerResult }> {
  let result: { ok: boolean } | { unknown: true; reason: string };
  try {
    result = await checkFormula!(latex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|timed\s*out|ETIMEDOUT|abort/i.test(msg)) {
      result = { unknown: true, reason: `formula tool timeout: ${msg}` };
    } else {
      return {
        outcome: "fail",
        result: {
          layer: "tool_result",
          outcome: "fail",
          reason: `formula tool error: ${msg}`,
          details: { latex },
        },
      };
    }
  }
  if ("unknown" in result && result.unknown) {
    return {
      outcome: "unknown",
      result: {
        layer: "tool_result",
        outcome: "unknown",
        reason: result.reason || "formula tool returned unknown",
        details: { latex },
      },
    };
  }
  if ("ok" in result && !result.ok) {
    return {
      outcome: "fail",
      result: {
        layer: "tool_result",
        outcome: "fail",
        reason: "formula check failed",
        details: { latex },
      },
    };
  }
  return { outcome: "pass" };
}

async function verifyToolResult(input: VerifyTeachingInput): Promise<LayerResult> {
  const latexSnippets: string[] = [];
  let unknown: LayerResult | undefined;
  for (const block of input.blocks) {
    const fields = [block.content.latex, block.content.formula];
    if (block.type === "steps" && Array.isArray(block.content.steps)) {
      fields.push(...block.content.steps.filter(step => typeof step === "string" && step.includes("=")));
    }
    const formulas = fields.filter((field): field is string => typeof field === "string" && !!field.trim());
    if (!formulas.length && (block.type === "formula" || block.type === "math")) {
      unknown ??= { layer: "tool_result", outcome: "unknown", reason: "formula block has no checkable latex" };
    }
    for (const formula of new Set(formulas)) {
      latexSnippets.push(...extractFormulaSnippets(formula));
    }
  }

  const uniqueSnippets = [...new Set(latexSnippets)];
  if (uniqueSnippets.length === 0) {
    return unknown ?? {
      layer: "tool_result",
      outcome: "skipped",
      reason: "no formula latex to check",
    };
  }

  if (!input.tools?.checkFormula) {
    return {
      layer: "tool_result",
      outcome: "unknown",
      reason: "formula content present but no formula tool configured",
    };
  }

  const checkFormula = input.tools.checkFormula;
  for (const latex of uniqueSnippets) {
    const checked = await runSingleFormulaCheck(checkFormula, latex);
    if (checked.outcome === "fail") return checked.result;
    if (checked.outcome === "unknown") {
      unknown ??= checked.result;
      // Split independent multi-clause segments before probing equality chains so
      // separate equations separated by ',', ';', '\implies', '<', or prose never cross-bridge.
      const clauses = splitMultiClauseFormula(latex);
      const multiClause = clauses.length > 1 || (clauses.length === 1 && clauses[0] !== latex.trim());
      for (const clause of clauses) {
        if (!clause.includes("=")) continue;
        if (multiClause) {
          const clauseCheck = await runSingleFormulaCheck(checkFormula, clause);
          if (clauseCheck.outcome === "fail") return clauseCheck.result;
          if (clauseCheck.outcome === "pass") continue;
        }
        const members = splitTopLevelEquals(clause).map(member => member.trim());
        if (members.length >= 3 && members.length <= 12 && members.every(Boolean)) {
          for (let i = 0; i < members.length; i++) {
            if (!isCleanEqualityMember(members[i]!)) continue;
            for (let j = i + 1; j < members.length; j++) {
              if (!isCleanEqualityMember(members[j]!)) break;
              const forward = await runSingleFormulaCheck(checkFormula, `${members[i]} = ${members[j]}`);
              if (forward.outcome === "fail") return forward.result;
              if (forward.outcome === "unknown") {
                const reverse = await runSingleFormulaCheck(checkFormula, `${members[j]} = ${members[i]}`);
                if (reverse.outcome === "fail") return reverse.result;
              }
            }
          }
        }
      }
    }
  }

  return unknown ?? {
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
 * Runs L1–L5; uses classifyClaimSupport only as a material-link heuristic.
 * Automatic checks never establish factual correctness or formal scoring authority.
 * Conflict/uncovered on core → fact fail;
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

