import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { createOpeningSpanTutorNextRepository, type OpeningSpanNextChoiceReason } from "@aistudy/database";
import { z } from "zod";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
const inputSchema = z.object({ activityId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  observationId: z.string().uuid().nullable(), clientKey: z.string().min(8).max(160) }).strict();
const choiceMessages: Record<OpeningSpanNextChoiceReason, string> = {
  unknown_evidence: "这份答案还不能确定判分；先核对答案或评价，不把它算作不会。原答案和学习位置保留。",
  source_unavailable: "原题或课程材料目前不可用或版本已变化；先恢复或核对材料，原答案保留。",
  authorization_required: "本课程导师授权尚未启用或已停止；请明确确认授权后再选择下一步。",
  cancelled: "原复测已取消或失效，未重新安排。可以回看原记录，再明确选择新的学习。",
  expired: "原复测的执行期限已过，未因过期降低能力记录；请回看原任务后选择新的学习时机。",
  unseen_unavailable: "当前题目曝光历史无法确认，或本组未见题族已用完。原学习位置保留，不会新增无法发题的活动。",
  evidence_changed: "原建议采用的评价已更正。已有派生活动、答案和帮助记录保留，请按原活动的最新记录明确选择下一步。",
};
export function createSpanNextActionService(sql: Sql) {
  const repository = createOpeningSpanTutorNextRepository(sql);
  return { async next(scope: Scope, raw: unknown) {
    const result = await repository.next(scope, inputSchema.parse(raw));
    if (result.kind === "choice") {
      const records = `/opening/courses/${result.courseId}#course-learning-records`;
      const sessionHref = (session: NonNullable<typeof result.originSession>) => {
        const params = new URLSearchParams({ lesson: session.activityId });
        if (session.retestId) params.set("retest", session.retestId);
        return `/opening/courses/${session.courseId}/study/span?${params}`;
      };
      const origin = result.originSession ? sessionHref(result.originSession) : records;
      const practice = `/opening/courses/${result.courseId}/study?${new URLSearchParams({ mode: "practice", skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY })}`;
      return { kind: "choice" as const, reason: result.reason, message: choiceMessages[result.reason],
        primary: result.reason === "evidence_changed" ? { label: result.originSession ? "查看原活动的最新记录，重新选择下一步" : "回看课程记录", href: origin }
          : result.reason === "unseen_unavailable" ? { label: "继续普通练习（不作为未见题验证）", href: practice }
          : result.reason === "authorization_required" ? { label: "保留原位置，核对导师授权", href: origin }
          : result.reason === "source_unavailable" ? { label: "恢复或核对课程材料", href: `/opening/courses/${result.courseId}` }
            : { label: "回看答案与课程记录", href: records },
        secondary: result.historicalSession ? { label: "查看派生活动的已有记录", href: sessionHref(result.historicalSession) }
          : { label: "返回原学习位置", href: origin } };
    }
    const params = new URLSearchParams({ lesson: result.session.activityId });
    if (result.session.retestId) params.set("retest", result.session.retestId);
    const label = result.replayed || !result.decision ? "打开已保存的下一步" : {
      targeted_explain: "开始针对性讲解", full_explain: "查看完整示例", diagnose: "开始一道短诊断",
      reduced_help_practice: "用一道新题少看提示", transfer_check: "独立完成一道新题",
    }[result.decision.activityKind];
    return { kind: "ready" as const, href: `/opening/courses/${result.session.courseId}/study/span?${params}`,
      activityId: result.session.activityId, sessionId: result.session.sessionId, courseId: result.session.courseId, label, resumed: result.replayed };
  } };
}
