/** Pure presentation boundary, not an endpoint, saved attempt or evidence receipt.
 * Inputs can contain private author material, even when statically typed. Never
 * parse/spread/serialize the whole input or pass it to a presentation authority.
 */
type PublicSource = { file: string; page: number };
type PublicQuestion = { questionId: string; source: PublicSource };
type PromptBinding = PublicQuestion & { text: string };
export type MaterialPromptAuthority = {
  /** Host-only dependency: verify this exact text is the public question body
   * for this source/question, not an answer, goal, error note or client claim.
   * Schema success/text-reviewed/source identity alone is insufficient. */
  verifyPrompt: (binding: PromptBinding) => boolean;
};
export type MaterialFirstAnswerPresentation =
  | (PublicQuestion & { kind: "material_first_answer"; status: "available"; prompt: { role: "prompt"; text: string } })
  | { kind: "material_first_answer"; status: "unavailable"; questionId: string | null; source: PublicSource | null;
      reason: "invalid_public_identity" | "missing_prompt_body" | "prompt_not_verified" };

/** Own data properties only: enumerable accessors, prototypes, nested objects
 * and unknown keys must never execute code or become display text. */
function field(input: unknown, name: string): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function text(input: unknown, max = 20000): string | null {
  return typeof input === "string" && input.trim().length > 0 && input.length <= max ? input : null;
}
function publicQuestion(input: unknown): PublicQuestion | null {
  const questionId = text(field(input, "id"), 200);
  const file = text(field(input, "sourceFile"), 200);
  const page = field(input, "physicalPage");
  return questionId && file && typeof page === "number" && Number.isSafeInteger(page) && page > 0
    ? { questionId, source: { file, page } } : null;
}
function body(input: unknown, role: "prompt" | "answer_key"): string | null {
  return field(input, "role") === role ? text(field(input, "text")) : null;
}

/** Exact allowlist: question identity, public citation and verified prompt only.
 * No notes/goals/errors/skill labels/answers, including as fallback title/text.
 * Source question IDs are not canonical families or learner measurements.
 */
export function projectMaterialFirstAnswer(input: unknown, authority?: MaterialPromptAuthority): MaterialFirstAnswerPresentation {
  const identity = publicQuestion(input);
  if (!identity) return { kind: "material_first_answer", status: "unavailable", questionId: null, source: null, reason: "invalid_public_identity" };
  const promptText = body(field(input, "prompt"), "prompt");
  if (!promptText) return { kind: "material_first_answer", status: "unavailable", questionId: identity.questionId,
    source: identity.source, reason: "missing_prompt_body" };
  // Pass a detached whitelist, not input or the eventual returned DTO.
  if (authority?.verifyPrompt({ questionId: identity.questionId, source: { file: identity.source.file, page: identity.source.page }, text: promptText }) !== true) {
    return { kind: "material_first_answer", status: "unavailable", questionId: identity.questionId,
      source: identity.source, reason: "prompt_not_verified" };
  }
  return { kind: "material_first_answer", status: "available", questionId: identity.questionId, source: identity.source,
    prompt: { role: "prompt", text: promptText } };
}

export type MaterialFeedbackAccessRequest = PublicQuestion & { attemptId: string; mode: "post_attempt" | "explicit_help" };
export type MaterialFeedbackSnapshot = { postAttemptNotes: string | null; answer: string | null };
export type MaterialFeedbackAuthority = {
  /** Trusted host DI, not a client capability or boolean identity check.
   * Resolve the authenticated owner, exact current question/source/attempt and
   * authorized phase, then return a detached, content/version-bound feedback
   * snapshot from trusted storage (or null to deny). Never copy raw input or
   * trust client version/authorization flags. post_attempt requires submission;
   * explicit_help requires authenticated help and exposure recording before
   * display. This module supplies NO real host implementation or persistence. */
  resolveFeedback: (request: MaterialFeedbackAccessRequest) => MaterialFeedbackSnapshot | null;
};
export type MaterialFeedbackPresentation =
  | { kind: "material_feedback"; status: "unavailable"; reason: "invalid_request" | "feedback_not_authorized" | "missing_feedback" }
  | (PublicQuestion & { kind: "material_feedback"; status: "available"; attemptId: string;
      exposure: "post_attempt" | "help"; independentEligibility: "unknown" | "non_independent";
      feedback: { postAttemptNotes: string | null; answer: string | null } });

/** Request data cannot authorize itself: only the injected trusted host can.
 * Early feedback is help/non-independent, never an independent success. The
 * host must record exposure before displaying it; this pure port does not save
 * anything, qualify BKT (single or composite), infer families or report mastery.
 */
export function projectMaterialFeedback(input: unknown, requestInput: unknown, authority?: MaterialFeedbackAuthority): MaterialFeedbackPresentation {
  const identity = publicQuestion(input);
  const questionId = field(requestInput, "questionId");
  const attemptId = text(field(requestInput, "attemptId"), 200);
  const mode = field(requestInput, "mode");
  if (!identity || questionId !== identity.questionId || !attemptId || (mode !== "post_attempt" && mode !== "explicit_help")) {
    return { kind: "material_feedback", status: "unavailable", reason: "invalid_request" };
  }
  const snapshot = authority?.resolveFeedback({ questionId: identity.questionId,
    source: { file: identity.source.file, page: identity.source.page }, attemptId, mode });
  if (!snapshot) return { kind: "material_feedback", status: "unavailable", reason: "feedback_not_authorized" };
  // Consume ONLY the host-resolved snapshot. Never read raw notes/answer, even
  // after authorization: same-ID substitution and callback mutation are unsafe.
  const postAttemptNotes = text(field(snapshot, "postAttemptNotes"));
  const answer = text(field(snapshot, "answer"));
  if (!postAttemptNotes && !answer) return { kind: "material_feedback", status: "unavailable", reason: "missing_feedback" };
  return { kind: "material_feedback", status: "available", questionId: identity.questionId, source: identity.source, attemptId,
    exposure: mode === "explicit_help" ? "help" : "post_attempt",
    independentEligibility: mode === "explicit_help" ? "non_independent" : "unknown", feedback: { postAttemptNotes, answer } };
}
