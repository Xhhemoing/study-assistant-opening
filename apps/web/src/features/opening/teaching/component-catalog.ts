/**
 * V2-10 controlled component catalog — allowlist + normalize + fail-soft decisions.
 * Pure functions; no DOM. Model picks components+params; client only maps.
 */

import type { ActivitySpecClientInit } from "@aistudy/contracts";
import { findUnsafeContent, isMarkupKey, isUnsafeUrl } from "@aistudy/jingwei";

export const CATALOG_IDS = [
  "text",
  "math",
  "step",
  "example",
  "question",
  "draft",
  "evidence",
  "matrix_transform",
] as const;

export type CatalogId = (typeof CATALOG_IDS)[number];

export type ClientInitBlock = ActivitySpecClientInit["blocks"][number];

export type FailSoftReason =
  | "unknown_component"
  | "illegal_link"
  | "illegal_action"
  | "unknown_schema_version"
  | "answer_hidden";

export type RenderDecision =
  | { ok: true; catalogId: CatalogId; params: Record<string, unknown> }
  | { ok: false; reason: FailSoftReason };

/** Known clientInit schemaVersion values (generationConfig.extras). Missing = OK. */
const KNOWN_SCHEMA_VERSIONS = new Set(["1", "v1"]);

const BLOCK_TYPE_ALIASES: Record<string, CatalogId> = {
  text: "text",
  math: "math",
  formula: "math",
  step: "step",
  steps: "step",
  example: "example",
  question: "question",
  prompt: "question",
  draft: "draft",
  evidence: "evidence",
  cite: "evidence",
  meta: "text",
  // V2-15: matrix_transform + legacy matrix-viz* (no longer collapse to text)
  matrix_transform: "matrix_transform",
  "matrix-viz": "matrix_transform",
  matrix_viz: "matrix_transform",
  matrixviz: "matrix_transform",
};

/**
 * Map library blockType + role → catalog id, or "unknown".
 * answer_key is never a catalog render target for plaintext.
 */
export function normalizeToCatalogId(
  blockType: string,
  role: string,
): CatalogId | "unknown" {
  const type = blockType.trim().toLowerCase();
  const r = role.trim().toLowerCase();
  if (r === "answer_key" || type === "answer_key") return "unknown";
  if (r === "prompt" && !BLOCK_TYPE_ALIASES[type]) return "question";
  if (r === "example" && !BLOCK_TYPE_ALIASES[type]) return "example";
  if (r === "meta" && !BLOCK_TYPE_ALIASES[type]) return "text";
  return BLOCK_TYPE_ALIASES[type] ?? "unknown";
}

/** Reject javascript:/data:/vbscript: — rule owned by jingwei; http(s) cite links stay allowed. */
export const isIllegalLink = isUnsafeUrl;

export function extractPlainParams(
  content: unknown,
): { params: Record<string, unknown>; illegalLink: boolean } {
  if (content == null) {
    return { params: {}, illegalLink: false };
  }
  if (typeof content === "string") {
    if (isIllegalLink(content)) return { params: {}, illegalLink: true };
    return { params: { text: content }, illegalLink: false };
  }
  if (typeof content !== "object" || Array.isArray(content)) {
    return { params: { text: String(content) }, illegalLink: false };
  }
  const raw = content as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  let illegalLink = false;
  for (const [key, value] of Object.entries(raw)) {
    // Teaching is stricter than the core at the top level: any unsafe-URL string is rejected.
    if (isMarkupKey(key) || (typeof value === "string" && isIllegalLink(value))) {
      illegalLink = true;
      continue;
    }
    params[key] = value;
  }
  // Nested URL fields / markup (e.g. steps[i].href) are checked by the shared core rules.
  const nested = findUnsafeContent(params);
  if (nested && (nested.kind === "link" || nested.kind === "markup" || nested.kind === "depth")) {
    illegalLink = true;
  }
  return { params, illegalLink };
}

export function readSchemaVersion(
  clientInit: Pick<ActivitySpecClientInit, "generationConfig"> | null | undefined,
): string | null {
  const extras = clientInit?.generationConfig?.extras;
  if (!extras || typeof extras !== "object") return null;
  const v = (extras as Record<string, unknown>).schemaVersion;
  if (v == null) return null;
  return String(v);
}

export function isKnownSchemaVersion(version: string | null): boolean {
  if (version == null || version === "") return true;
  return KNOWN_SCHEMA_VERSIONS.has(version.trim().toLowerCase());
}

/**
 * Decide how (or whether) to render one clientInit block.
 * Hidden answer_key → answer_hidden (never plaintext).
 * Unknown blockType → unknown_component (caller continues remaining blocks).
 */
export function decideBlockRender(
  block: ClientInitBlock,
  opts?: { schemaVersion?: string | null },
): RenderDecision {
  if (opts?.schemaVersion != null && !isKnownSchemaVersion(opts.schemaVersion)) {
    return { ok: false, reason: "unknown_schema_version" };
  }

  if (
    block.role === "answer_key" ||
    block.blockType.toLowerCase() === "answer_key"
  ) {
    if (block.answerRef?.revealState === "hidden" || block.content == null) {
      return { ok: false, reason: "answer_hidden" };
    }
    // Revealed answer_key still maps via catalog only if type normalizes; never invent HTML.
  }

  const catalogId = normalizeToCatalogId(block.blockType, block.role);
  if (catalogId === "unknown") {
    // Gated answer still answer_hidden if that was the intent
    if (block.role === "answer_key") {
      return { ok: false, reason: "answer_hidden" };
    }
    return { ok: false, reason: "unknown_component" };
  }

  const { params, illegalLink } = extractPlainParams(block.content);
  if (illegalLink) {
    return { ok: false, reason: "illegal_link" };
  }

  // Action-like params that look like JS handlers
  if (findUnsafeContent(params)?.kind === "handler") {
    return { ok: false, reason: "illegal_action" };
  }

  return {
    ok: true,
    catalogId,
    params: {
      ...params,
      blockId: block.blockId,
      position: block.position,
      role: block.role,
      blockType: block.blockType,
    },
  };
}

export function failSoftReasonLabel(reason: FailSoftReason): string {
  switch (reason) {
    case "unknown_component":
      return "未知组件类型，已跳过该块";
    case "illegal_link":
      return "含有不安全链接，已跳过该块";
    case "illegal_action":
      return "含有未授权动作，已跳过该块";
    case "unknown_schema_version":
      return "教学内容版本不受支持";
    case "answer_hidden":
      return "解析尚未解锁（需服务端授权后查看）";
    default:
      return "该块暂时无法展示";
  }
}
