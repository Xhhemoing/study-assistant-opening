import { buildAnswerGradingInput, isBudgetReplayError, OpeningModelRoutingError, type ModelGateway } from "@aistudy/ai";
import { aiGradingInputSchema, aiGradingProposalSchema, type LearningObservation, type ProviderInput, type Scope } from "@aistudy/contracts";
import type { createOpeningAiGradingRepository } from "@aistudy/database";

type Repository = ReturnType<typeof createOpeningAiGradingRepository>;
type GatewayOptions = Parameters<ModelGateway["call"]>[2];

function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: "CONFLICT" });
}

/** Follow only ledger-confirmed unsent attempts; unknown and in-flight calls are never reissued. */
async function callGrader(gateway: Pick<ModelGateway, "call">, scope: Scope,
  task: "practice.grade-photo" | "practice.grade-text", options: GatewayOptions) {
  const base = options.operationId;
  let operationId = base;
  const visited = new Set<string>();
  for (let index = 0; index < 16; index += 1) {
    try { return await gateway.call(scope, task, { ...options, operationId }); }
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

export function createOpeningAiGradingService(deps: {
  repository: Repository;
  gateway: Pick<ModelGateway, "call">;
  budget(scope: Scope): GatewayOptions["budget"];
  images(scope: Scope, input: { sourceIds: string[]; sourceVersions: Record<string, number>; physicalPage: number }): Promise<ProviderInput["imageParts"]>;
}) {
  return {
    async grade(scope: Scope, raw: unknown, signal?: AbortSignal): Promise<LearningObservation> {
      const input = aiGradingInputSchema.parse(raw);
      const context = await deps.repository.context(scope, input);
      if (context.existing) return context.existing;
      const imageParts = context.workSource ? await deps.images(scope, {
        sourceIds: [context.workSource.id], sourceVersions: { [context.workSource.id]: context.workSource.version },
        physicalPage: context.workSource.physicalPage,
      }) : [];
      if (context.workSource && !imageParts.length) throw conflict("暂时无法读取作答照片，请检查图片后重试。原答案已保存。");
      if (!context.observation.answer.trim() && !imageParts.length) throw conflict("请先填写答案或选择作答照片。");
      let result: LearningObservation | null = null;
      let modelLabel: string | null = null;
      try {
        await callGrader(deps.gateway, scope, imageParts.length ? "practice.grade-photo" : "practice.grade-text", {
          budget: deps.budget(scope), operationId: `ai-grade:${scope.workspaceId}:${input.observationId}`,
          resultRef: `ai-grade:${input.observationId}`, signal,
          beforeSend: async () => { await deps.repository.context(scope, input); },
          onModel: model => { modelLabel = model.modelSnapshot.modelName; },
          input: buildAnswerGradingInput({ question: context.stem, answer: context.observation.answer,
            referenceText: context.referenceText, misconceptions: context.misconceptions, imageParts }),
          persistResult: async output => {
            let proposal;
            try { proposal = aiGradingProposalSchema.parse(JSON.parse(output.text)); }
            catch { throw conflict("这次批改未返回完整的评分结果。原答案已保存，可以手动改评。"); }
            result = await deps.repository.apply(scope, input, proposal, modelLabel);
          },
        });
      } catch (error) {
        // A committed grade remains usable if settlement or the response was interrupted.
        const saved = await deps.repository.context(scope, input);
        if (saved.existing) return saved.existing;
        if (isBudgetReplayError(error)) {
          throw conflict(error.disposition.kind === "in_flight"
            ? "正在批改这份答案，请稍后查看。"
            : "这次批改尚未完成，原答案已保存，可以手动改评。");
        }
        if (error instanceof OpeningModelRoutingError) throw conflict("请先在设置中配置可用的批改模型。原答案已保存。");
        if (error instanceof Error && "code" in error && ["NOT_FOUND", "VALIDATION", "CONFLICT"].includes(String(error.code))) throw error;
        throw conflict("AI 批改暂时未完成。原答案已保存，请稍后查看或手动改评。");
      }
      if (!result) throw conflict("批改结果尚未保存，请稍后查看。原答案仍然保留。");
      return result;
    },
  };
}
