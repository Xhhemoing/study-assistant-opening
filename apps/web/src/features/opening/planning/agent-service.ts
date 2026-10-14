import "server-only";
import type { Sql } from "postgres";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { planningAgentInputSchema, type Scope, type PlanningAgentResult } from "@aistudy/contracts";
import { estimateUsage, usageFromOutput, runPlanningAgent } from "@aistudy/ai";
import { deriveDayBlocks, guidanceProtectedBlocks, planDay } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningPlanningAgentRepository, createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository, createOpeningPrivacyRepository, createOpeningMemoryRepository } from "@aistudy/database";
import { resolveTutorModel } from "../../../../../worker/src/runtime/tutor-model";
import { runBudgetedCall } from "../../../../../worker/src/runtime/budgeted-call";
import { getLearningReadService } from "../runtime";
import { ApiError } from "../../auth/service";
import { buildServerPlanDayOptions } from "./plan-service";

export async function planWithAgent(sql: Sql, scope: Scope, raw: unknown, callerSignal?: AbortSignal): Promise<PlanningAgentResult> {
  const input = planningAgentInputSchema.parse(raw);
  const privacy = createOpeningPrivacyRepository(sql);
  const epoch = await privacy.getWorkspaceEpoch(scope);
  const preference = await createOpeningPlanningSettingsRepository(sql).get(scope);
  if (!preference.saved || !preference.settings || preference.invalidStoredSettings) {
    throw new ApiError("VALIDATION", "请先设置可用时间；未配置 AI 时仍可从材料开始学习。", 422);
  }
  const timeZone = preference.settings.timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const date = ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-");
  const learning = getLearningReadService(sql);
  // Authorization before any model call/run reservation; do not trust the model to scope a course.
  const summaries = input.courseId ? await learning.summarizeLearning(scope, input.courseId) : [];
  const runs = createOpeningPlanningAgentRepository(sql);
  const start = await runs.start(scope, input, epoch);
  if (start.kind === "replayed") {
    const result = start.result;
    if (result.draft) {
      const current = await createOpeningPlansRepository(sql).findDraftByProposeClientKey(scope, result.draft.date, `planning-agent:${result.runId}`);
      return { ...result, draft: current };
    }
    return result;
  }
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  try {
    const snapshot = await runs.snapshot(scope, date);
    if (snapshot.preference.settings?.timeZone !== timeZone) throw new ApiError("CONFLICT", "时区已变化，请重新规划。", 409);
    const relevantIds = new Set(snapshot.state?.blocks.map(b => b.taskId) ?? []);
    snapshot.tasks = snapshot.tasks.filter(t => t.status === "pending" || relevantIds.has(t.id));
    if (snapshot.tasks.length > 200) throw new ApiError("VALIDATION", "任务过多，请先整理已完成任务。", 422);
    const protectedWindows = guidanceProtectedBlocks(date, timeZone, snapshot.guidance);
    const pending = snapshot.tasks.filter(t => t.status === "pending");
    if (!pending.length) {
      const result = { runId: start.id, message: "还没有待学习任务。先从材料确定一个具体主题，或接受聊天中的任务建议。", draft: null,
        tasks: snapshot.tasks, timeZone, modelCalls: 0 };
      await runs.complete(scope, start.id, result, epoch);
      return result;
    }
    if (pending.length > 50) throw new ApiError("VALIDATION", "首版规划一次最多读取 50 个待办，请先整理任务。", 422);
    const model = await resolveTutorModel(sql, scope, "explain", { answerStyle: false });
    const budget = createOpeningBudgetRepository(sql, { envCapCents: loadOpeningModelCatalog().dailyCapCents, pricingConfigured: model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0 });
    const guard = async () => {
      signal.throwIfAborted();
      if (await privacy.getWorkspaceEpoch(scope) !== epoch) throw new ApiError("CONFLICT", "隐私设置已变化，规划已停止。", 409);
    };
    const outcome = await runPlanningAgent({ text: input.text,
      context: { date, timeZone, goal: snapshot.goal, guidance: { mode: snapshot.guidance.mode, dailyMinutes: snapshot.guidance.dailyMinutes, automaticReorderingActive: false }, tasks: pending.map(t => ({ id: t.id, title: t.title, minutes: t.minutes,
        dueAt: t.dueAt, priority: t.priority, reviewNotBefore: t.retest?.recommendedAt ?? null, reviewSkill: t.retest?.skillLabel ?? null })) },
      pendingTaskIds: pending.map(t => t.id), courseBound: Boolean(input.courseId), signal, guard,
      read: async tool => {
        await guard();
        if (tool === "schedule") return { accepted: snapshot.state?.blocks ?? [], timetable: snapshot.timetable.slice(0, 50),
          available: deriveDayBlocks(date, snapshot.preference.settings!, snapshot.timetable, protectedWindows), locked: snapshot.hard.filter(b => b.kind === "locked") };
        if (tool === "learning") return summaries.slice(0, 50).map(s => ({ skill: s.skillLabel, status: s.status, sampleCount: s.sampleCount,
          recentPerformance: s.recentPerformance, unverifiedCount: s.unverifiedCount, lastObservedAt: s.lastObservedAt }));
        const context = await createOpeningMemoryRepository(sql).listContext(scope, new Date().toISOString(), input.courseId);
        return context.memories.slice(0, 10).map(m => ({ text: m.text.slice(0, 500) }));
      },
      complete: (providerInput, step) => {
        const operationId = `planning-agent:${start.id}:step:${step}`;
        return runBudgetedCall({ provider: model.provider, input: providerInput, signal,
          budget: { reserve: entry => budget.reserve(scope, entry), release: (id, reason) => budget.release(scope, id, reason),
            claimExecution: id => budget.claimExecution(scope, id), settle: (...args) => budget.settle(scope, ...args), markUnknown: id => budget.markUnknown(scope, id) },
          operationId, requestId: operationId, purpose: "planning-agent", modelSnapshot: model.modelSnapshot,
          resultRef: `planning_agent_run:${start.id}`,
          reservedCents: Math.max(1, estimateUsage({ inputTokens: Buffer.byteLength(JSON.stringify(providerInput), "utf8") + 4096,
            outputTokens: providerInput.maxOutputTokens, estimated: true }, model)),
          actualCents: output => estimateUsage(usageFromOutput(output), model), beforeSend: guard });
      },
      propose: async ids => {
        await guard();
        const now = new Date();
        const originalBlocks = snapshot.state?.blocks ?? [];
        const preserved = originalBlocks.filter(b => Date.parse(b.start) <= now.getTime());
        const protectedIds = new Set(preserved.map(b => b.taskId));
        const free = [...deriveDayBlocks(date, snapshot.preference.settings!, snapshot.timetable, protectedWindows), ...snapshot.hard.filter(b => b.kind === "locked")];
        const result = planDay(snapshot.tasks.filter(t => !protectedIds.has(t.id)),
          [...free, ...preserved.map(b => ({ start: b.start, end: b.end, kind: "locked" as const }))],
          { ...buildServerPlanDayOptions({ date, timeZone, now, preferredOrder: ids }), planningNow: new Date(now.getTime() + 120000).toISOString() });
        let remaining = Math.max(0, snapshot.guidance.dailyMinutes - preserved.reduce((n, b) => n + (Date.parse(b.end) - Date.parse(b.start)) / 60000, 0));
        const budgetedBlocks = result.blocks.filter(block => {
          const minutes = (Date.parse(block.end) - Date.parse(block.start)) / 60000;
          if (minutes > remaining) return false;
          remaining -= minutes; return true;
        });
        const deferredIds = result.blocks.filter(b => !budgetedBlocks.includes(b)).map(b => b.taskId);
        return runs.saveDraft(scope, { date, tasks: snapshot.tasks, free,
          blocks: [...preserved, ...budgetedBlocks].sort((a, b) => a.start.localeCompare(b.start)), unscheduledTaskIds: [...new Set([...result.unscheduledTaskIds, ...deferredIds])],
          clientKey: `planning-agent:${start.id}` }, { stateHash: snapshot.stateHash, epoch, expiresAt: new Date(now.getTime() + 120000).toISOString() }, originalBlocks);
      },
    });
    const result = { runId: start.id, message: outcome.message, draft: outcome.proposal,
      tasks: snapshot.tasks, timeZone, modelCalls: outcome.modelCalls };
    await guard();
    await runs.complete(scope, start.id, result, epoch);
    return result;
  } catch (error) {
    await runs.fail(scope, start.id);
    throw error;
  }
}
