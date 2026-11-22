import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { applyLearnerMisconceptionCorrection, learnerMisconceptionDispositions, readTryMisconceptionHandoffClock, redeemTryMisconceptionHandoff, type OpeningScope } from "@aistudy/database";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../../auth/service";
import { readOpeningRawBody } from "../request-body";
import { challenges, gradeTry, type TryChallenge } from "./challenges";

const receiptTtlMs = 15 * 60 * 1000;
// The sequence in v2 is PostgreSQL-wide. Earlier signatures used a process-local counter.
const receiptNamespace = "opening:try-misconception:v2";
export const tryMisconceptionReceiptMaxLength = 4096;

function isPostgresText(value: string) {
  return !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
}

const correctionSchema = z.object({
  edgeId: z.string().uuid(),
  disposition: z.enum(learnerMisconceptionDispositions),
  summary: z.string().trim().min(1).max(4096).refine(isPostgresText),
}).strict();

const selectionSchema = z.object({
  challenge: z.string().max(32),
  step: z.number().int().nonnegative(),
  reason: z.number().int().nonnegative(),
}).strict();
const receiptPayloadSchema = z.object({
  receiptId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  issueSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().positive(),
  conceptKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  misconceptionCode: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  summary: z.string().min(1).max(256).refine(isPostgresText),
}).strict().refine(payload => payload.expiresAt > payload.issuedAt && payload.expiresAt - payload.issuedAt <= receiptTtlMs);

const signals: Record<TryChallenge["id"], { misconceptionCode: string; summary: string }> = {
  limit: { misconceptionCode: "lhopital-preconditions", summary: "公开挑战提示可复习洛必达法则的适用条件。" },
  integral: { misconceptionCode: "substitution-bounds", summary: "公开挑战提示可复习积分换元时如何更新积分限。" },
  matrix: { misconceptionCode: "matrix-cancellation", summary: "公开挑战提示可复习矩阵左消去的成立条件。" },
};

function requireSigningSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.trim().length < 32) {
    throw new ApiError("CONFIGURATION", "体验记录服务暂不可用。", 503);
  }
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(receiptNamespace + "." + encodedPayload).digest("base64url");
}

function selectedMisconception(input: unknown): TryChallenge["id"] | null {
  const { challenge, step, reason } = selectionSchema.parse(input);
  const question = challenges.find(item => item.id === challenge);
  if (!question || step >= question.steps.length || reason >= question.reasons.length) {
    throw new ApiError("VALIDATION", "请选择有效的挑战和答案。", 400);
  }
  const { stepCorrect, reasonCorrect } = gradeTry(question, step, reason);
  return stepCorrect && reasonCorrect ? null : question.id;
}

type ReceiptStamp = Awaited<ReturnType<typeof readTryMisconceptionHandoffClock>>;

function signReceipt(conceptKey: TryChallenge["id"], secret: string, { nowMs, issueSeq }: ReceiptStamp): string {
  const payload = receiptPayloadSchema.parse({
    receiptId: randomUUID(), issuedAt: nowMs, issueSeq, expiresAt: nowMs + receiptTtlMs,
    conceptKey, ...signals[conceptKey],
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return encodedPayload + "." + sign(encodedPayload, secret);
}

export function issueTryMisconceptionReceipt(input: unknown, secret: string | undefined, stamp: ReceiptStamp): string | null {
  const conceptKey = selectedMisconception(input);
  if (!conceptKey) return null;
  requireSigningSecret(secret);
  return signReceipt(conceptKey, secret, stamp);
}

export async function issueSignedTryMisconceptionReceipt(
  database: Sql | { readonly sql: Sql }, input: unknown, secret = process.env.AUTH_SECRET,
): Promise<string | null> {
  const conceptKey = selectedMisconception(input);
  if (!conceptKey) return null;
  requireSigningSecret(secret);
  const stamp = await readTryMisconceptionHandoffClock("sql" in database ? database.sql : database);
  return signReceipt(conceptKey, secret, stamp);
}

export function verifyTryMisconceptionReceipt(receipt: string, secret = process.env.AUTH_SECRET) {
  const invalid = () => new ApiError("UNAUTHENTICATED", "体验记录无效。", 401);
  if (receipt.length > tryMisconceptionReceiptMaxLength) throw invalid();
  const [encodedPayload, signature, extra] = receipt.split(".");
  if (!encodedPayload || !signature || extra !== undefined
    || !/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw invalid();
  requireSigningSecret(secret);
  const expected = sign(encodedPayload, secret);
  if (!timingSafeEqual(Buffer.from(signature, "ascii"), Buffer.from(expected, "ascii"))) throw invalid();
  const bytes = Buffer.from(encodedPayload, "base64url");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  const result = receiptPayloadSchema.safeParse(parsed);
  if (!result.success) throw invalid();
  const { receiptId, issuedAt, issueSeq, expiresAt, conceptKey, misconceptionCode, summary } = result.data;
  return { receiptId, issuedAt, issueSeq, expiresAt, conceptKey, misconceptionCode, summary,
    payloadSha256: createHash("sha256").update(bytes).digest("hex") };
}

export function redeemSignedTryMisconceptionReceipt(sql: Sql, scope: OpeningScope, receipt: string) {
  return redeemTryMisconceptionHandoff(sql, scope, verifyTryMisconceptionReceipt(receipt));
}

export function applyBitemporalCorrection(sql: Sql, scope: OpeningScope, input: unknown) {
  return applyLearnerMisconceptionCorrection(sql, scope, correctionSchema.parse(input));
}

export async function readMisconceptionRequest(request: Request): Promise<unknown> {
  const bytes = await readOpeningRawBody(request, 16 * 1024);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError("VALIDATION", "请提交有效的 UTF-8 JSON。", 400);
  }
}
