import { isDeepStrictEqual } from "node:util";
import { buildAnswerGradingInput } from "./answer-grading";
import { isBudgetReplayError } from "./budgeted-call";
import { OpeningModelRoutingError } from "./model-routing";
import type { ModelGateway } from "./model-gateway";
import { aiGradingInputSchema, aiGradingMaterialProvenanceSchema, aiGradingProposalSchema, type AiGradingInput, type AiGradingMaterialProvenance, type AiGradingProposal, type LearningObservation, type ProviderInput, type Scope, type TeachingMisconception } from "@aistudy/contracts";

type GatewayOptions = Parameters<ModelGateway["call"]>[2];
/** Structural boundary: AI must not import database (database already uses AI). */
export type OpeningAiGradingServiceDeps = {
  repository: {
    context(scope: Scope, input: AiGradingInput): Promise<{
      observation: LearningObservation; existing: LearningObservation | null;
      stem: string; referenceText: string; misconceptions: TeachingMisconception[];
      workSource: { id: string; version: number; physicalPage: number } | null;
      answerRevision: number; operationId: string;
      materialProvenance: AiGradingMaterialProvenance;
    }>;
    apply(scope: Scope, input: AiGradingInput, proposal: AiGradingProposal, modelLabel: string | null, materialProvenance: AiGradingMaterialProvenance): Promise<LearningObservation>;
    ledger(scope: Scope, operationId: string): Promise<"unsent" | "in_flight" | "unknown" | "completed" | "blocked">;
    /** Optional for older adapters. Only an exact, scope/purpose/parent-matching
     * confirmed release may bypass the old reservation's model/price snapshot. */
    releasedReservation?(scope: Scope, input: Parameters<GatewayOptions["budget"]["reserve"]>[0]):
      Promise<{ id: string; state: "released"; releaseReason: string } | null>;
  };
  gateway: Pick<ModelGateway, "call">;
  budget(scope: Scope): GatewayOptions["budget"];
  images(scope: Scope, input: { sourceIds: string[]; sourceVersions: Record<string, number>; physicalPage: number }): Promise<ProviderInput["imageParts"]>;
};

const conflict = (message: string, code = "CONFLICT") => Object.assign(new Error(message), { code });
const unknownCost = () => conflict("这次批改费用或发送结果尚未确认，原答案已保存。请手动改评，不会再次发送模型请求。", "GRADING_UNKNOWN_COST");

/** Follow only ledger-confirmed unsent attempts; never bypass a prior fallback. */
async function callGrader(deps: OpeningAiGradingServiceDeps, scope: Scope,
  task: "practice.grade-photo" | "practice.grade-text", options: GatewayOptions) {
  const base = options.operationId;
  const releasedReservation = deps.repository.releasedReservation;
  const budget = releasedReservation ? { ...options.budget,
    reserve: async (input: Parameters<GatewayOptions["budget"]["reserve"]>[0]) => {
      // The gateway may enter a fallback within one call. Recheck the family
      // here too, before skipping any released primary/retry snapshot.
      const ledger = await deps.repository.ledger(scope, base);
      if (ledger === "unknown" || ledger === "in_flight") throw unknownCost();
      if (ledger !== "unsent") throw conflict("这次批改已有发送记录，原答案已保存，请手动改评。");
      return await releasedReservation(scope, input) ?? options.budget.reserve(input);
    },
  } : options.budget;
  let operationId = base;
  const visited = new Set<string>();
  for (let index = 0; index < 16; index += 1) {
    const ledger = await deps.repository.ledger(scope, base);
    if (ledger === "unknown" || ledger === "in_flight") throw unknownCost();
    if (ledger !== "unsent") throw conflict("这次批改已有发送记录，原答案已保存，请手动改评。");
    try { return await deps.gateway.call(scope, task, { ...options, budget, operationId }); }
    catch (error) {
      if (!isBudgetReplayError(error) || error.disposition.kind !== "released"
        || !["not_sent", "cancelled"].includes(error.disposition.reason ?? "")) throw error;
      const next = `${base}:retry:${error.disposition.reservationId}`;
      if (visited.has(next)) throw error;
      visited.add(next); operationId = next;
    }
  }
  throw conflict("这份答案多次未能发送批改，请检查模型设置后手动改评。");
}

export function createOpeningAiGradingService(deps: OpeningAiGradingServiceDeps) {
  return {
    async grade(scope: Scope, raw: unknown, signal?: AbortSignal): Promise<LearningObservation> {
      const input = aiGradingInputSchema.parse(raw);
      const context = await deps.repository.context(scope, input);
      if (context.existing) return context.existing;
      // Clone the original dependencies that produced the prompt, never replace
      // them with a newer context merely because the question/answer ids match.
      const materialProvenance = aiGradingMaterialProvenanceSchema.parse(context.materialProvenance);
      const imageParts = context.workSource ? await deps.images(scope, {
        sourceIds: [context.workSource.id], sourceVersions: { [context.workSource.id]: context.workSource.version },
        physicalPage: context.workSource.physicalPage,
      }) : [];
      if (context.workSource && !imageParts.length) throw conflict("暂时无法读取作答照片，请检查图片后重试。原答案已保存。");
      if (!context.observation.answer.trim() && !imageParts.length) throw conflict("请先填写答案或选择作答照片。");
      let result: LearningObservation | null = null;
      let modelLabel: string | null = null;
      try {
        await callGrader(deps, scope, imageParts.length ? "practice.grade-photo" : "practice.grade-text", {
          budget: deps.budget(scope), operationId: context.operationId,
          resultRef: `ai-grade:${input.observationId}`, signal,
          beforeSend: async () => {
            const live = await deps.repository.context(scope, input);
            if (!isDeepStrictEqual(materialProvenance, live.materialProvenance)) {
              throw conflict("批改使用的答案或资料分类已修订，原答案已保存，请核验后重试。");
            }
          },
          onModel: model => { modelLabel = model.modelSnapshot.modelName; },
          input: buildAnswerGradingInput({ question: context.stem, answer: context.observation.answer,
            referenceText: context.referenceText, misconceptions: context.misconceptions, imageParts }),
          persistResult: async output => {
            let proposal;
            try { proposal = aiGradingProposalSchema.parse(JSON.parse(output.text)); }
            catch { throw conflict("这次批改未返回完整的评分结果。原答案已保存，可以手动改评。"); }
            result = await deps.repository.apply(scope, input, proposal, modelLabel, materialProvenance);
          },
        });
      } catch (error) {
        // Publication is fenced inside apply; an interrupted settlement does not
        // erase an already durable result. The status reader still reports unknown cost.
        let recoveryError: unknown;
        const saved = await deps.repository.context(scope, input).catch(error => {
          // A newly disputed/unreadable source may now reject context reads. It
          // does not erase a send receipt or turn unknown spend into retryable work.
          recoveryError = error; return null;
        });
        if (saved?.existing) return saved.existing;
        if (["unknown", "in_flight"].includes(await deps.repository.ledger(scope, context.operationId))) throw unknownCost();
        if (recoveryError) throw recoveryError;
        if (isBudgetReplayError(error)) {
          if (["in_flight", "unknown"].includes(error.disposition.kind)) throw unknownCost();
          throw conflict("这次批改尚未完成，原答案已保存，可以手动改评。");
        }
        if (error instanceof OpeningModelRoutingError) throw conflict("请先在设置中配置可用的批改模型。原答案已保存。");
        if (error instanceof Error && "code" in error && ["NOT_FOUND", "VALIDATION", "CONFLICT", "GRADING_UNKNOWN_COST"].includes(String(error.code))) throw error;
        throw conflict("AI 批改暂时未完成。原答案已保存，请稍后查看或手动改评。");
      }
      if (!result) throw conflict("批改结果尚未保存，请稍后查看。原答案仍然保留。");
      return result;
    },
  };
}
