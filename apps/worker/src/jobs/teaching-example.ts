import { buildWorkedExampleProviderInput, parseWorkedExampleOutput, type ModelGateway } from "@aistudy/ai";
import { openingJobScope, teachingExampleJobPayloadSchema, type OpeningJobRecord, type createOpeningTeachingExamplesRepository } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";

type Repository = ReturnType<typeof createOpeningTeachingExamplesRepository>;
export function createTeachingExampleHandler(deps: {
  repository: Pick<Repository, "assertCurrent" | "publish" | "read" | "ledger">;
  gateway: Pick<ModelGateway, "call">;
  budget(scope: Scope): Parameters<ModelGateway["call"]>[2]["budget"];
}) {
  return async (job: OpeningJobRecord, raw: unknown) => {
    const payload = teachingExampleJobPayloadSchema.parse(raw), scope = openingJobScope(job);
    if (!job.claimToken || job.kind !== "compile-teaching-unit" || job.key !== `teaching-example:${payload.request.clientKey}`) {
      throw Object.assign(new Error("例题任务执行身份不一致。"), { code: "CONFLICT" });
    }
    const prior = await deps.repository.read(scope, job.id);
    if (prior.publication) return prior;
    if (await deps.repository.ledger(scope, job.id) !== "unsent") throw Object.assign(new Error("例题已有发送记录，费用或结果待确认，不会重发。"), { code: "CONFLICT" });
    await deps.repository.assertCurrent(scope, payload);
    const input = buildWorkedExampleProviderInput({ originalExample: payload.originalExample });
    await deps.gateway.call(scope, "practice.grade-text", {
      budget: deps.budget(scope), input, operationId: `teaching-example:${job.id}`, resultRef: `teaching-example:${job.id}`,
      beforeSend: () => deps.repository.assertCurrent(scope, payload),
      persistResult: async output => {
        const proposal = parseWorkedExampleOutput(output.text, { originalExample: payload.originalExample });
        await deps.repository.publish(scope, job.id, payload, proposal);
      },
    });
    const saved = await deps.repository.read(scope, job.id);
    if (!saved.publication) throw Object.assign(new Error("例题未完成原子发布，不能记为成功。"), { code: "CONFLICT" });
    return saved;
  };
}
