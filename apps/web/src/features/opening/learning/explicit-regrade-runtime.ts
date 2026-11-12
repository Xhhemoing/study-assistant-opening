import "server-only";
import type { Sql } from "postgres";
import { z } from "zod";
import { aiGradingStatusSchema, explicitRegradeConfirmSchema, explicitRegradePrepareSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningExplicitRegradeRequestRepository, readOpeningObservationGradingUsesVision } from "@aistudy/database";
import { resolveAutoGradePolicy } from "./auto-grade-policy";

const readSchema = z.object({ observationId: uuidSchema, clientKey: z.string().trim().min(1).max(200), requestId: uuidSchema.nullish() }).strict();

/** HTTP owns orchestration only. Pricing uses the existing metadata-only budget estimator;
 * paid-input authority and crash recovery remain in the repository/worker. */
export function getExplicitRegradeService(sql: Sql) {
  const repository = createOpeningExplicitRegradeRequestRepository(sql);
  type Read = Awaited<ReturnType<typeof repository.read>>;
  async function policy(scope: Scope, observationId: string, photo: boolean) {
    const vision = await readOpeningObservationGradingUsesVision(sql, scope, observationId);
    const resolved = await resolveAutoGradePolicy(sql, scope, photo || vision === true);
    return vision === null ? { ...resolved, modelAvailable: false } : resolved;
  }
  function matchesCurrent({ request, snapshot }: Read) {
    return snapshot.rootObservationId === request.rootObservationId
      && snapshot.expectedHead === (request.resultObservationId ?? request.expectedHead)
      && snapshot.answerRevision === request.answerRevision && snapshot.privacyEpoch === request.privacyEpoch
      && snapshot.previousGradingVersion === (request.state === "confirmed" ? request.gradingVersion : request.previousGradingVersion);
  }
  function progress(result: Read) {
    const { request, snapshot } = result;
    if (!matchesCurrent(result)) return { kind: "conflict" as const, snapshot };
    // Consent persistence alone is not a job or a result. Never borrow legacy status.
    const status = result.status === "pending_enqueue" || result.status === "prepared" ? null
      : aiGradingStatusSchema.parse({ rootObservationId: request.rootObservationId,
        headObservationId: result.status === "graded" ? request.resultObservationId : request.expectedHead,
        answerRevision: request.answerRevision, jobId: request.jobId, workSource: request.workSource,
        retryable: false, status: result.status });
    return { kind: "progress" as const, progress: { request, status }, snapshot };
  }
  async function read(scope: Scope, raw: unknown) {
    const input = readSchema.parse(raw);
    const selector = { ...input, requestId: input.requestId ?? undefined };
    // Read the persisted identity before routing, never trust caller media flags.
    const initial = await repository.read(scope, selector);
    if (!matchesCurrent(initial)) return { kind: "conflict" as const, snapshot: initial.snapshot };
    if (initial.request.state !== "prepared") return progress(initial);
    const result = await repository.read(scope, selector,
      await policy(scope, initial.request.expectedHead, Boolean(initial.request.workSource)));
    if (!matchesCurrent(result)) return { kind: "conflict" as const, snapshot: result.snapshot };
    if (result.request.state !== "prepared") return progress(result);
    return { kind: "prepared" as const, request: result.request, snapshot: result.snapshot, estimateCents: result.estimateCents,
      estimate: result.estimateCents === null ? null
        : `当前预估预留 ¥${(result.estimateCents / 100).toFixed(2)}（不是费用上限；备用模型可能改变费用，实际费用按实际用量及配置价格计入账单；旧请求仍可能另行收费）` };
  }
  return {
    snapshot: repository.snapshot,
    read,
    async prepare(scope: Scope, raw: unknown) {
      const input = explicitRegradePrepareSchema.parse(raw);
      const request = await repository.prepare(scope, input);
      return read(scope, { observationId: input.observationId, clientKey: input.clientKey, requestId: request.requestId });
    },
    async confirm(scope: Scope, raw: unknown) {
      const input = explicitRegradeConfirmSchema.parse(raw);
      const initial = await repository.read(scope, input.requestId);
      if (!matchesCurrent(initial)) return { kind: "conflict" as const, snapshot: initial.snapshot };
      const request = await repository.confirm(scope, input, initial.request.state === "prepared"
        ? await policy(scope, initial.request.expectedHead, Boolean(initial.request.workSource)) : undefined);
      return progress(await repository.read(scope, request.requestId));
    },
  };
}
