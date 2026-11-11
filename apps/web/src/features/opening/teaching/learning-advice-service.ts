import { z } from "zod";
import { createOpeningLearningAdviceContextRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import type { NextLearningStep } from "@aistudy/domain";
import { ApiError } from "../../auth/service";

type Rule = Pick<NextLearningStep, "activityKind" | "reasonCode">;
export type LearningAdviceInput = { attemptId: string; expectedRevision: number; optIn: boolean };
export type LearningAdviceResponse = {
  advice: { ruleDecision: Rule; status: "disabled"; experimentalAdvice: null } | null;
  experimentState: "off";
  messageCode: "rule_only" | "advice_unavailable";
};
const bodySchema = z.object({ attemptId: z.string().uuid(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), optIn: z.boolean() }).strict();
const invalid = () => new ApiError("VALIDATION", "Invalid learning advice request", 400);

/** A bounded same-origin POST, never a grant or a scope producer. Authentication belongs to the route. */
export async function parseLearningAdviceRequest(request: Request, activityId: string): Promise<LearningAdviceInput> {
  const id = z.string().uuid().safeParse(activityId);
  if (!id.success || request.method !== "POST" || request.headers.get("origin") !== new URL(request.url).origin
    || request.headers.get("sec-fetch-site") === "cross-site"
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) throw invalid();
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096)) throw invalid();
  if (!request.body) throw invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw invalid(); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    throw invalid();
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw invalid(); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/** Production composition stays in the application layer; the route creates this per request. */
export function createSqlOpeningLearningAdviceService(sql: Sql) {
  return createOpeningLearningAdviceService(createOpeningLearningAdviceContextRepository(sql).read);
}

/** Instantiate per request. The experiment allowlist is empty: there is deliberately no BKT dependency. */
export function createOpeningLearningAdviceService(readContext: (scope: Scope, anchor: {
  activityId: string; attemptId: string; expectedRevision: number;
}) => Promise<{ ruleDecision: Rule } | null>) {
  return {
    async read(scope: Scope, activityId: string, input: LearningAdviceInput): Promise<LearningAdviceResponse> {
      const context = await readContext(scope, { activityId, attemptId: input.attemptId, expectedRevision: input.expectedRevision });
      if (!context) return { advice: null, experimentState: "off", messageCode: "advice_unavailable" };
      // Project explicitly, even if a repository object later acquires private metadata.
      return { advice: { ruleDecision: { activityKind: context.ruleDecision.activityKind, reasonCode: context.ruleDecision.reasonCode },
        status: "disabled", experimentalAdvice: null }, experimentState: "off", messageCode: "rule_only" };
    },
  };
}
