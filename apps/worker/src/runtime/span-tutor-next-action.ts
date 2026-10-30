import type { Sql } from "postgres";
import type { SpanLessonSnapshot } from "@aistudy/contracts";
import { createOpeningSpanTutorContextRepository, createOpeningLearningAgendaRepository } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { TutorNextAction, TutorNextActionContext, TutorNextActionService } from "../jobs/tutor-next-action";

function action(session: SpanLessonSnapshot): TutorNextAction {
  const params = new URLSearchParams({ lesson: session.activityId });
  if (session.retestId) params.set("retest", session.retestId);
  return { activityId: session.activityId, sessionId: session.sessionId,
    href: `/opening/courses/${session.courseId}/study/span?${params}` };
}
function storedContext(context: TutorNextActionContext) {
  if (!context.spanContext) throw Object.assign(new Error("span tutor context missing"), { code: "CONFLICT" });
  return context.spanContext;
}
export function createSpanTutorNextAction(sql: Sql): TutorNextActionService {
  const repository = createOpeningSpanTutorContextRepository(sql);
  const agendaRepository = createOpeningLearningAgendaRepository(sql);
  return {
    async read(scope, request) {
      const context = await repository.read(scope, { ...request, entry: "worker" });
      const changed = context?.originChange;
      const changeAction = changed ? {
        message: changed.reason === "source_unavailable" ? "原建议的资料已变化；派生活动和已有答案保留，请先核对资料。" : "原建议采用的评价已更正；派生活动保留，请按原活动的最新记录重新选择下一步。",
        label: changed.reason === "evidence_changed" && changed.originSession ? "查看原活动的最新记录" : "核对课程资料和记录",
        href: changed.reason === "evidence_changed" && changed.originSession ? action(changed.originSession).href : `/opening/courses/${context!.courseId}#course-learning-records`,
      } : undefined;
      const agenda = context?.resumeSession ? await agendaRepository.get(scope, context.courseId, context.resumeSession.activityId) : null;
      return context ? { courseId: context.courseId, privacyEpoch: context.privacyEpoch, sourceRefs: context.sourceRefs,
        decisionInput: context.decisionInput, spanContext: context, historicalDecision: context.historicalDecision,
        agenda,
        ...(changeAction ? { unavailableAction: changeAction } : {}),
        ...(context.needsReservedIssue ? { resumeRequiresExecution: true } : {}),
        ...(context.unseenUnavailableReason ? { unavailableAction: {
          message: context.unseenUnavailableReason === "unknown_history" ? "原题曝光记录暂不可核实；先保留当前进度，可核对记录或选择普通练习。" : "本组未见题族已用完；可以继续普通练习，重复练习不会标作未见检查。",
          label: "继续普通练习（不作为未见题验证）", href: `/opening/courses/${context.courseId}/study?${new URLSearchParams({ mode: "practice", skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY })}`,
        } } : {}),
        ...(context.resumeSession ? { resume: action(context.resumeSession) } : {}) } : null;
    },
    assertCurrent: (scope, context) => repository.assertCurrent(scope, storedContext(context)),
    async execute(scope, input) {
      return action(await repository.execute(scope, { ...input, context: storedContext(input.context) }));
    },
  };
}
