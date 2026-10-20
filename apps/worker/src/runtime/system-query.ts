import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { runSystemQuery, renderSystemQuery, type SystemQueryService, type SystemQueryPlanner } from "@aistudy/ai";
import { createScopedOpeningSystemQueryReader, readOpeningSystemQueryAuthorization, mergeContextSourceRefs, parseContextSourceRefs } from "@aistudy/database";
import { loadFeatureSwitches } from "@aistudy/config";

type QueryModelOptions = { parentBudget: import("@aistudy/ai").ParentInteractionBudget; operationId: string; signal?: AbortSignal; beforeSend?: () => Promise<void> };
type QueryModelCall = (scope: import("@aistudy/contracts").Scope, input: import("@aistudy/contracts").ProviderInput, options: QueryModelOptions) => Promise<import("@aistudy/contracts").ProviderOutput>;
/** Bound contextual referent resolution by the same cancellation/deadline as actual reads. */
async function queryContextBeforeDeadline<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("system query cancelled or timed out");
  let abort!: () => void;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      abort = () => reject(new Error("system query cancelled or timed out"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
/** Reuse the one router/vault/ledger path, loading model configuration only for an actual query. */
async function callDbQueryModel(sql: Sql, scope: import("@aistudy/contracts").Scope, input: import("@aistudy/contracts").ProviderInput, options: QueryModelOptions) {
  const [{ createDbModelGateway, scopeBudget }, { createOpeningBudgetRepository }, { loadOpeningModelCatalog }] = await Promise.all([
    import("./model-gateway"), import("@aistudy/database"), import("@aistudy/config"),
  ]);
  const catalog = loadOpeningModelCatalog();
  const budget = createOpeningBudgetRepository(sql, { envCapCents: catalog.dailyCapCents,
    pricingConfigured: catalog.models.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0) });
  return createDbModelGateway(sql).call(scope, "tutor.listen", { ...options, input, budget: scopeBudget(budget, scope) });
}
/** Native planning is bounded; deterministic reads remain available when models cannot provide tools. */
export function createDbSystemQueryService(sql: Sql, process: "web" | "worker", options: { callModel?: QueryModelCall; planner?: SystemQueryPlanner } = {}): SystemQueryService {
  const enabled = () => loadFeatureSwitches().systemQuery;
  return { enabled, async reply(scope, input, outerSignal) {
    if (!enabled()) throw new Error("系统记录查询暂未开启。");
    const controller = new AbortController(), abort = () => controller.abort();
    outerSignal?.addEventListener("abort", abort, { once: true });
    if (outerSignal?.aborted) abort();
    const timer = setTimeout(abort, 12000);
    try {
      const frame = await readOpeningSystemQueryAuthorization(sql, scope, "system_record_lookup", controller.signal);
      const assertCurrent = async () => {
        const current = await readOpeningSystemQueryAuthorization(sql, scope, "system_record_lookup", controller.signal);
        if (current.authorization.permissionRevision !== frame.authorization.permissionRevision) throw new Error("query permission changed");
        if (input.jobLease) {
          const [lease] = await sql`SELECT j.id FROM opening_tutor_jobs j JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
            WHERE j.id=${input.jobLease.jobId} AND j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
              AND j.status='running' AND j.claim_token=${input.jobLease.claimToken}`;
          if (!lease) throw new Error("query job is no longer current");
        }
      };
      const parentBudget = input.parentBudget ?? { id: `study-query:${scope.workspaceId}:${randomUUID()}` };
      const receipt = await runSystemQuery({ ...frame,
        callModel: options.planner ?? ((request, round, signal) => (options.callModel ?? ((owner, request, context) => callDbQueryModel(sql, owner, request, context)))(scope, request, {
          parentBudget, operationId: `system-query:${parentBudget.id}:round:${round}`, signal, beforeSend: assertCurrent,
        })), question: input.question, previousQuestion: input.resolvePreviousQuestion ? await queryContextBeforeDeadline(() => input.resolvePreviousQuestion!(frame.privacyEpoch), controller.signal) : input.previousQuestion, resolveObjects: true, focus: input.focus, signal: controller.signal, assertCurrent,
        read: createScopedOpeningSystemQueryReader(sql, scope, { purpose: "system_record_lookup", publicSettings: () => {
          const flags = loadFeatureSwitches(); return { process, adaptivePlanning: flags.adaptivePlanning, teachingLoop: flags.teachingLoop.api };
        } }),
      });
      await queryContextBeforeDeadline(assertCurrent, controller.signal);
      if (controller.signal.aborted) throw new Error("system query cancelled");
      return { text: renderSystemQuery(receipt), receipt, privacyEpoch: frame.privacyEpoch,
        contextSourceRefs: mergeContextSourceRefs(...receipt.results.map(result => result.sourceRefs)) };
    } finally { clearTimeout(timer); outerSignal?.removeEventListener("abort", abort); }
  } };
}

/** The Composer's plan/teach intents create drafts; learner confirmation owns the mutation. */
export function createDbAssistantProposalService(sql: Sql, options: {
  callModel?: (scope: import("@aistudy/contracts").Scope, input: import("@aistudy/contracts").ProviderInput,
    options: { parentBudget: import("@aistudy/ai").ParentInteractionBudget; operationId: string; signal?: AbortSignal; beforeSend?: () => Promise<void> }) => Promise<import("@aistudy/contracts").ProviderOutput>;
} = {}): import("@aistudy/ai").AssistantProposalService {
  return { async reply(scope, input, signal) {
    const { createOpeningAssistantProposalsRepository } = await import("@aistudy/database");
    const { runAssistantProposal } = await import("@aistudy/ai");
    const { resolveWorkspaceTimeZone, localDateKeyInZone } = await import("@aistudy/domain");
    if (signal?.aborted) throw new Error("proposal cancelled");
    const frame = await readOpeningSystemQueryAuthorization(sql, scope);
    const repo = createOpeningAssistantProposalsRepository(sql);
    const clientKey = `composer-proposal:${input.sourceTurnId}`;
    const previous = await repo.findByClientKey(scope, clientKey);
    let proposal = previous;
    if (!proposal) {
      let fallback: import("@aistudy/contracts").AssistantProposalTool;
      if (input.purpose === "teach") {
        if (!input.courseId) throw new Error("请先选择课程，再提出教学活动草稿。");
        fallback = { name: "propose_teaching_move", arguments: { courseId: input.courseId, topic: input.question.slice(0, 2000) } };
      } else {
        const [preferences] = await sql`SELECT planning_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
        const date = localDateKeyInZone(new Date(), resolveWorkspaceTimeZone(preferences?.planning_settings?.timeZone));
        const [state] = await sql`SELECT accepted_version FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND day=${date}::date`;
        fallback = { name: "propose_plan_change", arguments: { date, expectedAcceptedVersion: Number(state?.accepted_version ?? 0) } };
      }
      const planned = await runAssistantProposal({ question: input.question, fallback, signal,
        propose: tool => repo.propose(scope, { sourceTurnId: input.sourceTurnId, clientKey, tool }, { jobLease: input.jobLease, expectedPrivacyEpoch: frame.privacyEpoch }),
        callModel: options.callModel ? (request, modelSignal) => options.callModel!(scope, request, {
          operationId: `composer-proposal-model:${input.sourceTurnId}`, parentBudget: input.parentBudget ?? { id: `study-turn:${input.sourceTurnId}` }, signal: modelSignal,
          beforeSend: async () => {
            const grant = await readOpeningSystemQueryAuthorization(sql, scope);
            if (grant.authorization.permissionRevision !== frame.authorization.permissionRevision) throw new Error("proposal context changed");
            if (input.jobLease) {
              const [lease] = await sql`SELECT id FROM opening_tutor_jobs WHERE id=${input.jobLease.jobId} AND workspace_id=${scope.workspaceId}
                AND user_turn_id=${input.sourceTurnId} AND status='running' AND claim_token=${input.jobLease.claimToken}`;
              if (!lease) throw new Error("proposal job is no longer current");
            }
          },
        }) : undefined,
      });
      proposal = planned.proposal;
    }
    const current = await readOpeningSystemQueryAuthorization(sql, scope);
    if (current.authorization.permissionRevision !== frame.authorization.permissionRevision || signal?.aborted) throw new Error("proposal context changed");
    const [stored] = await sql`SELECT context_source_refs FROM opening_assistant_proposals WHERE id=${proposal.id}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const refs = parseContextSourceRefs(stored?.context_source_refs);
    if (!refs) throw new Error("proposal provenance unavailable");
    return { text: `已准备${input.purpose === "plan" ? "计划调整" : "教学活动"}草稿。请在提案卡中核对并明确接受；当前${proposal.status === "draft" ? "尚未应用" : "已处理"}。这不是掌握结论。`,
      proposal, privacyEpoch: frame.privacyEpoch, contextSourceRefs: mergeContextSourceRefs(refs) };
  } };
}
