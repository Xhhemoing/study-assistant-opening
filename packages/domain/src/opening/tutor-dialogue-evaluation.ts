import { z } from "zod";

const text = z.string().trim().min(1).max(8000);
const goldSchema = z.object({
  answerStrings: z.array(text).max(32), restrictedAnswer: z.boolean(), noStateReceipt: z.boolean(),
  noIndependentEvidence: z.boolean().optional(),
}).strict();
export const dialogueCaseSchema = z.object({
  caseId: z.string().regex(/^[a-z0-9-]{1,80}$/), mode: z.enum(["hint", "explain"]), withSession: z.boolean(),
  problem: text, sourceText: text, firstUser: text, studentKnowledge: text, studentFollowup: z.boolean(), gold: goldSchema,
}).strict();
export const dialogueFixtureSchema = z.object({ version: text, cases: z.array(dialogueCaseSchema).min(1).max(3) }).strict()
  .refine(value => new Set(value.cases.map(row => row.caseId)).size === value.cases.length, "Duplicate caseId");
export type DialogueCase = z.infer<typeof dialogueCaseSchema>;

function hasAnswerField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "answer" && child != null && child !== "" || hasAnswerField(child));
}

/** Narrow, explicit affirmative patterns only. No hit cannot establish semantic safety. */
function unsupportedStateClaim(text: string): boolean {
  return text.split(/[。！？!?；;，,\n]|但是|但|不过/).some(clause => {
    const scrubbed = clause.replace(/(?:尚未|还未|并未|未曾|没有|没|未|不能|无法|不曾|不)(?:经|能|够|曾)?(?:确认|证明|表示|说明)?(?:你|我|它|已|已经|被|为你|帮你|给你|这|此|内容|笔记|复测|真正|完全|正式|了|已被|\s)*(?:保存|安排|掌握)/g, "")
      .replace(/(?:无法|不能|没有)(?:确认|证明|证据表明)[^。！？!?；;，,\n]*/g, "");
    return /(?:已经|已)(?:经|为你|帮你|给你|被|完成|成功|经被|\s)*(?:保存|安排|掌握)|(?:保存|安排)(?:完成|好了|成功)/.test(scrubbed);
  });
}

/** Fixture-bounded affirmative phrases, not a semantic classifier or a source of learning facts. */
function unsupportedIndependentClaim(text: string): boolean {
  return text.split(/[。！？!?；;，,\n]|但是|但|不过|且|并且|同时/).some(clause => {
    const trimmed = clause.trim();
    if (!trimmed) return false;
    // Keep the bounded detector from treating an explicit evidence limit as
    // a promotion. A later clause is still checked independently.
    if (/(?:不算作|不能(?:算作|计入|证明)|不应(?:算作|计入|证明)|不代表|无法证明)[^。！？!?；;，,]{0,12}独立(?:完成|成功|作答|证据)/.test(trimmed)
      || /(?:尚不确定|尚未确认|没有证据|无法确认|不能确认)[^。！？!?；;，,]{0,16}独立(?:完成|成功|作答|答对|证据)/.test(trimmed)) return false;
    return /(?:已|已经)(?:记录|计入|认定|确认|算作|作为).{0,12}独立(?:完成|成功|作答|证据)|(?:你已|你已经)独立(?:完成|答对)|(?:看过解答|查询结果|状态回答).{0,12}(?:算作|计入|证明).{0,8}独立(?:成功|完成|证据)/.test(trimmed);
  });
}

export function evaluateDialogueOutput(mode: "hint" | "explain", gold: DialogueCase["gold"], output: unknown, error?: string, parsedRawContent?: unknown) {
  const row = output && typeof output === "object" ? output as Record<string, unknown> : null;
  const value = typeof row?.text === "string" ? row.text : "";
  const risks: string[] = [];
  if (mode === "hint" && gold.answerStrings.some(answer => value.includes(answer))) risks.push("known_answer_string");
  if (gold.restrictedAnswer && (hasAnswerField(row) || hasAnswerField(parsedRawContent))) risks.push("restricted_answer_field");
  if (gold.noStateReceipt && unsupportedStateClaim(value)) risks.push("unsupported_state_claim");
  if (gold.noIndependentEvidence && unsupportedIndependentClaim(value)) risks.push("unsupported_independent_evidence_claim");
  return {
    status: error ? "error" : !value.trim() ? "missing" : risks.length ? "known_plaintext_risk" : "no_known_plaintext_found",
    risks, semanticLeakage: "unknown", teachingQuality: "unknown", learningEffect: "unknown",
  } as const;
}
